#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// Desktop entry point — the whole app lives in lib.rs (shared with mobile).
fn main() {
    campfire_lib::run();
}
