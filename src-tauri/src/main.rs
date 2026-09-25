// Prevents an extra console window on Windows; harmless elsewhere.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    pi_gui_lib::set_webview_env();
    pi_gui_lib::run()
}
