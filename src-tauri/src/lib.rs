use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

/// Sidecar handle: stdin is shared with commands, stdout is read on a
/// dedicated thread (kept alive there to avoid EOF on drop).
pub struct Sidecar {
    stdin: Mutex< std::process::ChildStdin>,
}

#[tauri::command]
fn pi_send(state: State<'_, Sidecar>, line: String) -> Result<(), String> {
    eprintln!("[sidecar] pi_send: {}", line.chars().take(120).collect::<String>());
    let mut stdin = state.stdin.lock().map_err(|e| e.to_string())?;
    writeln!(stdin, "{}", line)
        .map_err(|e| e.to_string())
}

/// Closing the window hides it to the tray (UI setting, on by default).
pub struct CloseToTray(AtomicBool);

#[tauri::command]
fn set_close_to_tray(state: State<'_, CloseToTray>, enabled: bool) {
    state.0.store(enabled, Ordering::Relaxed);
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Pokaż Pi Code", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Zakończ", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Pi Code")
        .menu(&menu)
        // Linux trays (AppIndicator) only open the menu; clicks work elsewhere.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn log_sidecar_started(_app: &tauri::App) {
    eprintln!("[sidecar] spawned, cwd={:?}", std::env::current_dir().ok());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(CloseToTray(AtomicBool::new(true)))
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.app_handle().state::<CloseToTray>().0.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            if let Err(e) = build_tray(app) {
                // No tray (e.g. no StatusNotifier host): closing must quit, not strand a hidden window.
                eprintln!("[tray] unavailable: {e}");
                app.state::<CloseToTray>().0.store(false, Ordering::Relaxed);
            }
            // Dev sidecar: `pnpm sidecar` (tsx) from the project root.
            // Production: swap for a bundled single-file node build.
            // Dev: launched from the project root (or cwd); prod will carry its own sidecar.
            let mut child = Command::new("pnpm")
                .args(["sidecar"])
                .current_dir(std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .expect("failed to spawn sidecar (pnpm sidecar)");

            let stdin = child.stdin.take().expect("sidecar stdin");
            let stdout = child.stdout.take().expect("sidecar stdout");

            log_sidecar_started(app);

            app.manage(Sidecar {
                stdin: Mutex::new(stdin),
            });

            // stdout lines -> "pi:out" events (JSONL, one event per line)
            let handle: AppHandle = app.handle().clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines().flatten() {
                    if line.trim().is_empty() {
                        continue;
                    }
                    if handle.emit("pi:out", line).is_err() {
                        break;
                    }
                }
                eprintln!("[sidecar] stdout EOF");
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![pi_send, set_close_to_tray])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
