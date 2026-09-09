#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// Campfire desktop app (Windows).
// - WebView loads https://campfire.dill.moe (the web app itself).
// - Tray icon: open app / current game / start-on-login toggle / quit.
// - Autostart via tauri-plugin-autostart (Task Scheduler entry).
// - Game watcher: polls process names (sysinfo), matches against Discord's
//   detectable-games DB (fetched once, cached locally, refreshed every 7 days),
//   and beacons {game, ts} to the server so it logs "Playing X" + playtime.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{
    menu::{IsMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle,
    Manager,
    Runtime,
};
use tauri_plugin_autostart::ManagerExt;

const SERVER: &str = "https://campfire.dill.moe";
const DISCORD_DB: &str = "https://discord.com/api/v10/applications/detectable";
const ICON_BYTES: &[u8] = include_bytes!("../icons/icon.ico");
const HEARTBEAT_SECS: u64 = 30;
const POLL_SECS: u64 = 5;

#[derive(serde::Deserialize)]
struct DbGame {
    name: String,
    executables: Option<Vec<DbExe>>,
}

#[derive(serde::Deserialize)]
struct DbExe {
    name: String,
    os: Option<String>,
    is_launcher: Option<bool>,
}

struct State {
    token: Mutex<Option<String>>,
    // (game name, [exe names])
    games: Mutex<Vec<(String, Vec<String>)>>,
    db_at: Mutex<u64>,
    signed_in: AtomicBool,
    // last game successfully beaconed (for tray menu rebuilds)
    current_game: Mutex<Option<String>>,
}

fn server_url() -> String {
    std::env::var("CAMPFIRE_URL").unwrap_or_else(|_| SERVER.to_string())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// Local timezone offset in minutes east of UTC (matches JS
// `-new Date().getTimezoneOffset()`). Sent with every watcher beacon so
// the server buckets playtime on the player's calendar days, not UTC.
fn local_tz_offset_min() -> i32 {
    ((chrono::Local::now().offset().local_minus_utc() / 60) as i32).clamp(-720, 840)
}

fn app_data_dir<R: Runtime>(app: &AppHandle<R>) -> std::path::PathBuf {
    app.path().app_data_dir().expect("app data dir")
}

// Build the (game, exes) list from Discord's detectable-games DB.
// win32 entries only, launchers skipped, folder prefixes stripped.
fn load_or_fetch_games<R: Runtime>(app: &AppHandle<R>, client: &reqwest::blocking::Client) {
    let state = app.state::<State>();
    let dir = app_data_dir(app);
    let _ = std::fs::create_dir_all(&dir);
    let cache = dir.join("games.json");
    let fresh_for_secs: u64 = 7 * 24 * 3600;
    let need_fetch = now_secs() - *state.db_at.lock().unwrap() >= fresh_for_secs;
    if need_fetch {
        let resp: Option<Vec<DbGame>> = client
            .get(DISCORD_DB)
            .header("User-Agent", "CampfireDesktop/0.1 (Windows)")
            .send()
            .ok()
            .and_then(|r| r.json().ok());
        if let Some(list) = resp {
            let mut by_exe: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
            for g in &list {
                let name = g.name.clone();
                for e in g.executables.as_deref().unwrap_or(&[]) {
                    if e.os.as_deref() != Some("win32") {
                        continue;
                    }
                    if e.is_launcher == Some(true) {
                        continue;
                    }
                    let base = e.name.rsplit('/').next().unwrap_or("").trim().to_lowercase();
                    if !base.ends_with(".exe") {
                        continue;
                    }
                    by_exe.entry(base).or_default().push(name.clone());
                }
            }
            let mut games: Vec<(String, Vec<String>)> = Vec::new();
            for (exe, names) in by_exe.iter() {
                for n in names {
                    if let Some(found) = games.iter_mut().find(|(gn, _)| *gn == *n) {
                        found.1.push(exe.clone());
                    } else {
                        games.push((n.clone(), vec![exe.clone()]));
                    }
                }
            }
            games.sort_by(|a, b| a.0.cmp(&b.0));
            if let Ok(json) = serde_json::to_string(&games) {
                let _ = std::fs::write(&cache, json);
                *state.db_at.lock().unwrap() = now_secs();
            }
            *state.games.lock().unwrap() = games;
        } else if cache.exists() {
            // Offline: fall back to the last cached DB.
            if let Ok(s) = std::fs::read_to_string(&cache) {
                if let Ok(v) = serde_json::from_str(&s) {
                    *state.games.lock().unwrap() = v;
                }
            }
        }
    } else if cache.exists() {
        if let Ok(s) = std::fs::read_to_string(&cache) {
            if let Ok(v) = serde_json::from_str(&s) {
                *state.games.lock().unwrap() = v;
            }
        }
    }
}

fn tray_menu<R: Runtime>(app: &AppHandle<R>, game: Option<&str>) -> tauri::Result<Menu<R>> {
    let label = game
        .map(|g| format!("Playing {g}"))
        .unwrap_or_else(|| "No game detected".to_string());
    let auto = app.autolaunch().is_enabled().unwrap_or(false);
    let open = MenuItem::with_id(app, "open", "Open Campfire", true, None::<&str>)?;
    let game_item = MenuItem::with_id(app, "game", label, false, None::<&str>)?;
    let autostart = MenuItem::with_id(
        app,
        "autostart",
        if auto { "Start on login: on" } else { "Start on login: off" },
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let items: [&dyn IsMenuItem<R>; 4] = [&open, &game_item, &autostart, &quit];
    Menu::with_items(app, &items)
}

fn update_tray<R: Runtime>(app: &AppHandle<R>, game: Option<&str>) {
    if let Some(tray) = app.tray_by_id("campfire") {
        if let Ok(menu) = tray_menu(app, game) {
            let _ = tray.set_menu(Some(menu));
            let tip = match game {
                Some(g) => format!("Campfire — playing {g}"),
                None => "Campfire".to_string(),
            };
            let _ = tray.set_tooltip(Some(tip.as_str()));
        }
    }
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_minimized().unwrap_or(false) {
            let _ = w.unminimize();
        }
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// Single left-click toggles the window (open/close), like Discord/Steam.
fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show_main_window(app);
        }
    }
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let a = app.autolaunch();
    if enabled {
        a.enable().map_err(|e| e.to_string())?;
    } else {
        a.disable().map_err(|e| e.to_string())?;
    }
    Ok(enabled)
}

#[tauri::command]
fn get_watch_state(app: AppHandle) -> serde_json::Value {
    let st = app.state::<State>();
    serde_json::json!({
        "signed_in": st.signed_in.load(Ordering::Relaxed),
        "games": st.games.lock().unwrap().len(),
    })
}

fn clear_game_on_exit<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<State>();
    let tok = state.token.lock().unwrap().clone();
    if let Some(tok) = tok {
        if let Ok(client) = reqwest::blocking::Client::builder()
            .user_agent("CampfireDesktop/0.1 (Windows)")
            .timeout(std::time::Duration::from_secs(5))
            .build()
        {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let _ = client
                .post(format!("{}/api/watcher/status", server_url()))
                .bearer_auth(&tok)
                .json(&serde_json::json!({ "game": null, "ts": ts, "tz": local_tz_offset_min() }))
                .send();
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        // Single instance: a second launch focuses the running window instead
        // of opening a duplicate app (which would double-beacon playtime).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .manage(State {
            token: Mutex::new(None),
            games: Mutex::new(Vec::new()),
            db_at: Mutex::new(0),
            signed_in: AtomicBool::new(false),
            current_game: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![get_autostart, set_autostart, get_watch_state])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let app = app.handle().clone();
            let icon = tauri::image::Image::from_bytes(ICON_BYTES)?;
            let _tray = TrayIconBuilder::with_id("campfire")
                .icon(icon)
                .tooltip("Campfire")
                .menu(&tray_menu(&app, None)?)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    let app = tray.app_handle();
                    match event {
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } => toggle_main_window(app),
                        // Double-click also fires Click events first; end open.
                        TrayIconEvent::DoubleClick {
                            button: MouseButton::Left,
                            ..
                        } => show_main_window(app),
                        _ => {}
                    }
                })
                .on_menu_event(|app, event| {
                    match event.id.0.as_str() {
                        "open" => show_main_window(app),
                        "autostart" => {
                            let a = app.autolaunch();
                            let _ = if a.is_enabled().unwrap_or(false) {
                                a.disable()
                            } else {
                                a.enable()
                            };
                            let cur =
                                app.state::<State>().current_game.lock().unwrap().clone();
                            update_tray(app, cur.as_deref());
                        }
                        "quit" => {
                            clear_game_on_exit(app);
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(&app)?;

            // Token sync: the webview is the real site; read its cf_token from
            // localStorage so the watcher can authenticate beacons. An
            // CAMPFIRE_TOKEN env var pre-seeds the token (headless/autostart).
            let env_token: Option<String> = std::env::var("CAMPFIRE_TOKEN").ok().filter(|s| !s.is_empty());
            let token_app = app.clone();
            std::thread::spawn(move || {
                let app = token_app;
                let state = app.state::<State>();
                let mut tok = state.token.lock().unwrap();
                *tok = env_token.clone();
                drop(tok);
                loop {
                    if let Some(win) = app.get_webview_window("main") {
                        let (tx, rx) = std::sync::mpsc::channel();
                        if let Ok(()) = win.eval_with_callback(
                            "localStorage.getItem('cf_token') || ''",
                            move |s: String| {
                                let _ = tx.send(s);
                            },
                        ) {
                            let v = rx.recv().ok().map(|s| s.trim_matches('"').to_string());
                            let mut tok = state.token.lock().unwrap();
                            *tok = v.filter(|s| !s.is_empty()).or(env_token.clone());
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_secs(15));
                }
            });

            // Game watcher: poll every POLL_SECS; beacon immediately on change and
            // every HEARTBEAT_SECS while playing (server credits capped time).
            let watch_app = app.clone();
            std::thread::spawn(move || {
                let app = watch_app;
                let state = app.state::<State>();
                let client = match reqwest::blocking::Client::builder()
                    .user_agent("CampfireDesktop/0.1 (Windows)")
                    .build()
                {
                    Ok(c) => c,
                    Err(_) => return,
                };
                load_or_fetch_games(&app, &client);
                let mut system = sysinfo::System::new_all();
                let last_game: Mutex<Option<String>> = Mutex::new(None);
                let last_heartbeat: Mutex<std::time::Instant> = Mutex::new(std::time::Instant::now());
                loop {
                    // remove_dead MUST be true: with false, exited processes linger
                    // in the map forever and closed games look "still playing".
                    let _ = system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
                    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
                    for p in system.processes().values() {
                        *counts.entry(p.name().to_string_lossy().to_lowercase()).or_insert(0) += 1;
                    }
                    let games: Vec<(String, Vec<String>)> = state.games.lock().unwrap().clone();
                    let mut best: Option<(usize, usize)> = None;
                    for (gi, (gname, exes)) in games.iter().enumerate() {
                        let total: usize = exes
                            .iter()
                            .map(|e| counts.get(e.as_str()).copied().unwrap_or(0))
                            .sum();
                        if total == 0 {
                            continue;
                        }
                        match best {
                            Some((b, bi)) => {
                                if total > b || (total == b && gname < &games[bi].0) {
                                    best = Some((total, gi));
                                }
                            }
                            None => best = Some((total, gi)),
                        }
                    }
                    let game: Option<String> = best.map(|(_, gi)| games[gi].0.clone());
                    let tok = state.token.lock().unwrap().clone();
                    if let Some(tok) = tok {
                        let changed = {
                            let last = last_game.lock().unwrap();
                            last.as_deref() != game.as_deref()
                        };
                        let due_heartbeat =
                            *last_heartbeat.lock().unwrap() + std::time::Duration::from_secs(HEARTBEAT_SECS)
                                <= std::time::Instant::now();
                        if changed || due_heartbeat {
                            let ts = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis())
                                .unwrap_or(0);
                            let body = match &game {
                                Some(g) => serde_json::json!({ "game": g, "ts": ts, "tz": local_tz_offset_min(), "source": "process" }),
                                None => serde_json::json!({ "game": null, "ts": ts, "tz": local_tz_offset_min() }),
                            };
                            let ok = client
                                .post(format!("{}/api/watcher/status", server_url()))
                                .bearer_auth(&tok)
                                .json(&body)
                                .send()
                                .map(|r| r.status().is_success())
                                .unwrap_or(false);
                            if ok {
                                state.signed_in.store(true, Ordering::Relaxed);
                                *last_heartbeat.lock().unwrap() = std::time::Instant::now();
                                *last_game.lock().unwrap() = game.clone();
                                *state.current_game.lock().unwrap() = game.clone();
                                update_tray(&app, game.as_deref());
                            }
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_secs(POLL_SECS));
                }
            });

            // Launched via autostart: stay in the tray, no window.
            if std::env::args().any(|a| a == "--autostart") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri app");
}
