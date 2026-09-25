use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

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

/// WebKitGTK variables this process set itself (not inherited from the user).
static OWN_ENV: OnceLock<Vec<&'static str>> = OnceLock::new();

/// WebKitGTK on NVIDIA + Wayland renders a black window; `pnpm desktop` sets these in the
/// shell, a packaged build (AppImage) has to set them itself. User values win.
pub fn set_webview_env() {
    let mut own = Vec::new();
    #[cfg(target_os = "linux")]
    for (key, value) in [
        ("GDK_BACKEND", "x11"),
        ("WEBKIT_DISABLE_COMPOSITING_MODE", "1"),
        ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
        ("LIBGL_ALWAYS_SOFTWARE", "1"),
    ] {
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, value);
            own.push(key);
        }
    }
    let _ = OWN_ENV.set(own);
}

/// The sidecar runs the model's tools (bash, git, python...), so it must see the user's
/// environment, not the AppImage's: AppRun points PYTHONHOME, LD_LIBRARY_PATH, PATH, XDG_*
/// etc. into the mounted image (python3 dies on start with that PYTHONHOME).
fn clean_sidecar_env(cmd: &mut Command) {
    for key in OWN_ENV.get().into_iter().flatten() {
        cmd.env_remove(key);
    }
    let Some(appdir) = std::env::var("APPDIR").ok().filter(|d| !d.is_empty()) else { return };
    for (key, value) in std::env::vars_os() {
        let Some(value) = value.to_str() else { continue };
        if key == "APPIMAGE" || !value.contains(&appdir) {
            continue;
        }
        let kept: Vec<&str> = value.split(':').filter(|p| !p.is_empty() && !p.contains(&appdir)).collect();
        if kept.is_empty() {
            cmd.env_remove(&key);
        } else {
            cmd.env(&key, kept.join(":"));
        }
    }
    cmd.env_remove("APPDIR");
}

/// Dev: `pnpm sidecar` (tsx) from the project root. Release (AppImage): the esbuild bundle
/// from the app resources, run by `$PI_CODE_NODE` or the system `node`.
fn sidecar_command(app: &tauri::App) -> Command {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    if cfg!(debug_assertions) {
        let mut cmd = Command::new("pnpm");
        cmd.arg("sidecar").current_dir(cwd);
        return cmd;
    }
    let res = app.path().resource_dir().expect("resource dir");
    let node = std::env::var_os("PI_CODE_NODE").unwrap_or_else(|| "node".into());
    let mut cmd = Command::new(node);
    cmd.arg(res.join("sidecar/dist/main.mjs"));
    clean_sidecar_env(&mut cmd);
    // AppRun cds into the mounted image; $OWD is where the AppImage was started. From a menu
    // that is often "/", so fall back to the home folder.
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let owd = std::env::var_os("OWD").map(std::path::PathBuf::from).filter(|p| p.as_os_str() != "/");
    if let Some(dir) = owd.or(home) {
        cmd.current_dir(dir);
    }
    cmd
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
            let mut child = sidecar_command(app)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .expect("failed to spawn sidecar");

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
