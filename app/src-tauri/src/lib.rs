// Campfire desktop/mobile app.
// - WebView loads https://campfire.dill.moe (the web app itself).
// - Desktop: tray icon (open app / current game / start-on-login toggle /
//   quit), autostart (Task Scheduler / LaunchAgent / XDG entry), and a game
//   watcher that polls process names (sysinfo), matches them against
//   Discord's detectable-games DB, and beacons {game, ts} to the server so
//   it logs "Playing X" + playtime.
// - Android: plain app shell (no tray/watcher/autostart — mobile has none).
#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(desktop)]
use std::sync::Mutex;
#[cfg(desktop)]
use tauri::{
    menu::{IsMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle,
    Manager,
    Runtime,
};
#[cfg(desktop)]
use tauri_plugin_autostart::ManagerExt;

const SERVER: &str = "https://campfire.dill.moe";
#[cfg(desktop)]
const DISCORD_DB: &str = "https://discord.com/api/v10/applications/detectable";
#[cfg(desktop)]
const ICON_BYTES: &[u8] = include_bytes!("../icons/icon.png");
#[cfg(desktop)]
const HEARTBEAT_SECS: u64 = 30;
#[cfg(desktop)]
const POLL_SECS: u64 = 5;

#[cfg(desktop)]
fn server_url() -> String {
    std::env::var("CAMPFIRE_URL").unwrap_or_else(|_| SERVER.to_string())
}

#[cfg(desktop)]
fn user_agent() -> String {
    format!(
        "CampfireDesktop/{} ({})",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS
    )
}

#[cfg(desktop)]
#[derive(serde::Deserialize)]
struct DbGame {
    name: String,
    executables: Option<Vec<DbExe>>,
}

#[cfg(desktop)]
#[derive(serde::Deserialize)]
struct DbExe {
    name: String,
    os: Option<String>,
    is_launcher: Option<bool>,
}

#[cfg(desktop)]
struct State {
    token: Mutex<Option<String>>,
    games: Mutex<Vec<GameEntry>>,
    // bare exe name -> number of games claiming it (discounts weak evidence)
    bare_share: Mutex<std::collections::HashMap<String, usize>>,
    db_at: Mutex<u64>,
    signed_in: AtomicBool,
    // last game successfully beaconed (for tray menu rebuilds)
    current_game: Mutex<Option<String>>,
    // every game scoring above threshold right now (for the Go Live picker)
    running_games: Mutex<Vec<String>>,
}

// Discord's DB tags each executable with an `os` ("win32" / "darwin" /
// "linux"; the non-desktop entries are sparse but real). Match only this
// platform's entries.
// --- game matching: two evidence tiers ------------------------------------
// A bare process name is weak evidence: GitHub CLI's `gh.exe` IS Green
// Hell's whole exe name, and any `java.exe` IS Illarion's — basename-only
// matching hallucinates games that were never installed. So:
// - foldered entries (`green hell/gh.exe`) only match when the process's
//   FULL path ends with them → strong evidence (2000 points);
// - bare entries (`rustclient.exe`, `>javaw.exe`) match on the basename but
//   are discounted by how many games share the name (1000 / share).
// A game is reported at >= 500: one tied weak exe, or anything stronger.
// (Real Green Hell still matches via its path; real Illarion via its
// `illario/jre/...` path; a random `gh`/`java` binary matches nothing.)
#[cfg(windows)]
const WANT_OS: &str = "win32";
#[cfg(target_os = "macos")]
const WANT_OS: &str = "darwin";
#[cfg(target_os = "linux")]
const WANT_OS: &str = "linux";

#[cfg(desktop)]
const SCORE_FOLDERED: u32 = 2000;
#[cfg(desktop)]
const SCORE_THRESHOLD: u32 = 500;

#[cfg(desktop)]
#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct GameEntry {
    name: String,
    foldered: Vec<String>,
    bare: Vec<String>,
}

#[cfg(desktop)]
fn build_bare_share(games: &[GameEntry]) -> std::collections::HashMap<String, usize> {
    let mut share = std::collections::HashMap::new();
    for g in games {
        for b in &g.bare {
            *share.entry(b.clone()).or_insert(0) += 1;
        }
    }
    share
}

// Local timezone offset in minutes east of UTC (matches JS
// `-new Date().getTimezoneOffset()`). Sent with every watcher beacon so
// the server buckets playtime on the player's calendar days, not UTC.
#[cfg(desktop)]
fn local_tz_offset_min() -> i32 {
    ((chrono::Local::now().offset().local_minus_utc() / 60) as i32).clamp(-720, 840)
}

#[cfg(desktop)]
fn app_data_dir<R: Runtime>(app: &AppHandle<R>) -> std::path::PathBuf {
    app.path().app_data_dir().expect("app data dir")
}

// Build the game list from Discord's detectable-games DB.
// Launchers skipped; entries keep their folder prefix (or lack of one) so
// matching can demand full-path evidence for foldered exes.
#[cfg(desktop)]
fn load_or_fetch_games<R: Runtime>(app: &AppHandle<R>, client: &reqwest::blocking::Client) {
    let state = app.state::<State>();
    let dir = app_data_dir(app);
    let _ = std::fs::create_dir_all(&dir);
    let cache = dir.join("games.json");
    let fresh_for_secs: u64 = 7 * 24 * 3600;
    let need_fetch = now_secs() - *state.db_at.lock().unwrap() >= fresh_for_secs;
    // On-disk cache (new format only — a legacy cache just misses here and
    // triggers a refetch, or stays empty until the network works).
    let read_cache = || -> Option<Vec<GameEntry>> {
        let s = std::fs::read_to_string(&cache).ok()?;
        serde_json::from_str(&s).ok()
    };
    let store = |games: &[GameEntry], share: &std::collections::HashMap<String, usize>| {
        if let Ok(json) = serde_json::to_string(games) {
            let _ = std::fs::write(&cache, json);
        }
        *state.db_at.lock().unwrap() = now_secs();
        *state.bare_share.lock().unwrap() = share.clone();
        *state.games.lock().unwrap() = games.to_vec();
    };
    if need_fetch {
        let resp: Option<Vec<DbGame>> = client
            .get(DISCORD_DB)
            .header("User-Agent", user_agent())
            .send()
            .ok()
            .and_then(|r| r.json().ok());
        if let Some(list) = resp {
            let mut games: Vec<GameEntry> = Vec::new();
            for g in &list {
                let mut foldered: Vec<String> = Vec::new();
                let mut bare: Vec<String> = Vec::new();
                for e in g.executables.as_deref().unwrap_or(&[]) {
                    if e.os.as_deref() != Some(WANT_OS) {
                        continue;
                    }
                    if e.is_launcher == Some(true) {
                        continue;
                    }
                    let norm = e.name.replace('\\', "/").trim().to_lowercase();
                    let norm = norm.strip_prefix('>').unwrap_or(&norm).to_string();
                    if norm.is_empty() {
                        continue;
                    }
                    if norm.contains('/') {
                        foldered.push(norm);
                    } else {
                        // Windows: exes end in .exe; other platforms have
                        // extensionless names, so only enforce it on Windows.
                        #[cfg(windows)]
                        if !norm.ends_with(".exe") {
                            continue;
                        }
                        bare.push(norm);
                    }
                }
                foldered.sort();
                foldered.dedup();
                bare.sort();
                bare.dedup();
                if foldered.is_empty() && bare.is_empty() {
                    continue;
                }
                games.push(GameEntry { name: g.name.clone(), foldered, bare });
            }
            games.sort_by(|a, b| a.name.cmp(&b.name));
            let share = build_bare_share(&games);
            store(&games, &share);
        } else if let Some(v) = read_cache() {
            // Offline: fall back to the last cached DB, then back off so a
            // dead network doesn't mean a fetch attempt every poll.
            let share = build_bare_share(&v);
            store(&v, &share);
        } else {
            *state.db_at.lock().unwrap() = now_secs();
        }
    } else if state.games.lock().unwrap().is_empty() {
        if let Some(v) = read_cache() {
            let share = build_bare_share(&v);
            *state.bare_share.lock().unwrap() = share;
            *state.games.lock().unwrap() = v;
        }
    }
}
#[cfg(desktop)]
fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(desktop)]
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

#[cfg(desktop)]
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

#[cfg(desktop)]
fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_minimized().unwrap_or(false) {
            let _ = w.unminimize();
        }
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// Single left-click toggles the window, like Discord/Steam — but a click may
// never *lose* a visible window: only an already-focused (frontmost) window
// gets tucked away to the tray. Clicking the tray with the window visible but
// sitting behind something else raises it instead.
#[cfg(desktop)]
fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let visible = w.is_visible().unwrap_or(false);
        let minimized = w.is_minimized().unwrap_or(false);
        let focused = w.is_focused().unwrap_or(false);
        if visible && !minimized && focused {
            let _ = w.hide();
        } else {
            show_main_window(app);
        }
    }
}

#[cfg(desktop)]
#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[cfg(desktop)]
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

#[cfg(desktop)]
#[tauri::command]
fn get_running_games(app: AppHandle) -> Vec<String> {
    app.state::<State>().running_games.lock().unwrap().clone()
}

#[cfg(desktop)]
#[tauri::command]
fn get_current_game(app: AppHandle) -> Option<String> {
    app.state::<State>().current_game.lock().unwrap().clone()
}

#[cfg(desktop)]
#[tauri::command]
fn get_watch_state(app: AppHandle) -> serde_json::Value {
    let st = app.state::<State>();
    serde_json::json!({
        "signed_in": st.signed_in.load(Ordering::Relaxed),
        "games": st.games.lock().unwrap().len(),
    })
}

// Open an external link in the OS default browser. Called by the
// frontend's Tauri link interceptor: target=_blank clicks die silently
// inside the WebView (at least on Windows/WebView2 — no navigation, no
// window, no error), so the page hands them here instead. Strict
// allowlist — http(s) only; same-origin links keep navigating in-app.
// Ungated: the Android shell needs this too.
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let u = url.trim();
    if !(u.starts_with("https://") || u.starts_with("http://")) {
        return Err("unsupported url".into());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(u, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(desktop)]
fn clear_game_on_exit<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<State>();
    let tok = state.token.lock().unwrap().clone();
    if let Some(tok) = tok {
        if let Ok(client) = reqwest::blocking::Client::builder()
            .user_agent(user_agent())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Opener on every platform: the frontend's Tauri link interceptor
    // hands external links to `open_external` so they launch in the OS
    // browser instead of dying inside the WebView.
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        // Single instance: a second launch focuses the running window instead
        // of opening a duplicate app (which would double-beacon playtime).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        // Remember window size/position across restarts (desktop only).
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(State {
            token: Mutex::new(None),
            games: Mutex::new(Vec::new()),
            bare_share: Mutex::new(std::collections::HashMap::new()),
            db_at: Mutex::new(0),
            signed_in: AtomicBool::new(false),
            current_game: Mutex::new(None),
            running_games: Mutex::new(Vec::new()),
        })
        .invoke_handler(tauri::generate_handler![get_autostart, set_autostart, get_watch_state, get_current_game, get_running_games, open_external])
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
                    .user_agent(user_agent())
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
                    // Index running processes two ways: basename presence (for
                    // bare entries) and full paths by basename (for foldered
                    // suffix tests). Both the exe path and sysinfo's display
                    // name feed the basename set (scripts/host processes).
                    let mut name_counts: std::collections::HashMap<String, usize> =
                        std::collections::HashMap::new();
                    let mut by_base: std::collections::HashMap<String, Vec<String>> =
                        std::collections::HashMap::new();
                    for p in system.processes().values() {
                        let full = p
                            .exe()
                            .map(|e| {
                                e.to_string_lossy().replace('\\', "/").to_lowercase()
                            })
                            .unwrap_or_default();
                        let base = full
                            .rsplit('/')
                            .next()
                            .unwrap_or("")
                            .to_string();
                        if !base.is_empty() {
                            *name_counts.entry(base.clone()).or_insert(0) += 1;
                            by_base.entry(base).or_default().push(full);
                        }
                        let disp = p.name().to_string_lossy().to_lowercase();
                        if !disp.is_empty() {
                            *name_counts.entry(disp).or_insert(0) += 1;
                        }
                    }
                    let games: Vec<GameEntry> = state.games.lock().unwrap().clone();
                    let share: std::collections::HashMap<String, usize> =
                        state.bare_share.lock().unwrap().clone();
                    // (score, distinct hits, name) — highest score wins, then
                    // most evidence, then alphabetical for determinism.
                    let mut scored: Vec<(u32, u32, String)> = Vec::new();
                    for g in &games {
                        let mut score: u32 = 0;
                        let mut hits: u32 = 0;
                        for f in &g.foldered {
                            let fb = f.rsplit('/').next().unwrap_or("");
                            if let Some(paths) = by_base.get(fb) {
                                let suf = String::from("/") + f;
                                if paths.iter().any(|ph| ph == f || ph.ends_with(&suf)) {
                                    score += SCORE_FOLDERED;
                                    hits += 1;
                                }
                            }
                        }
                        for b in &g.bare {
                            if name_counts.contains_key(b) {
                                let sh = share.get(b).copied().unwrap_or(1).max(1) as u32;
                                score += 1000 / sh;
                                hits += 1;
                            }
                        }
                        if score < SCORE_THRESHOLD {
                            continue;
                        }
                        scored.push((score, hits, g.name.clone()));
                    }
                    scored.sort_by(|a, b| {
                        b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then(a.2.cmp(&b.2))
                    });
                    // Everything above threshold counts as running (feeds the
                    // Go Live picker); the top hit is the beaconed game.
                    // Updated every poll regardless of sign-in so the picker
                    // works even before the first beacon succeeds.
                    let running: Vec<String> = scored
                        .iter()
                        .take(8)
                        .map(|(_, _, n)| n.clone())
                        .collect();
                    *state.running_games.lock().unwrap() = running;
                    let game: Option<String> =
                        scored.into_iter().next().map(|(_, _, n)| n);
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
        });
    // Mobile shell has no desktop plugins/commands — but it still needs
    // the external-link opener (same WebView swallowing applies).
    #[cfg(not(desktop))]
    let builder = builder.invoke_handler(tauri::generate_handler![open_external]);
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri app");
}
