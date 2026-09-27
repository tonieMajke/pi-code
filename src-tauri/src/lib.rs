use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

/// Sidecar handle: stdin is shared with commands, stdout is read on a dedicated thread.
/// When the sidecar dies on its own, that thread tells the UI (`pi:down`), starts a new one
/// and says so (`pi:up`) — the UI then boots again and reopens its session.
pub struct Sidecar {
    stdin: Mutex<Option<std::process::ChildStdin>>,
    child: Mutex<Option<std::process::Child>>,
    /// The app is quitting: a closed stdout is expected, not a crash.
    exiting: AtomicBool,
    /// Recent automatic restarts, to give up on a sidecar that dies right away.
    restarts: Mutex<Vec<std::time::Instant>>,
}

/// Wait up to `ms` for the process to end, then kill its whole process group — in dev that is
/// pnpm → tsx → node, plus MCP servers and tool processes it started.
fn reap(mut child: std::process::Child, ms: u64) -> Option<std::process::ExitStatus> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(ms);
    let mut status = None;
    while std::time::Instant::now() < deadline {
        if let Ok(Some(s)) = child.try_wait() {
            status = Some(s);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let _ = Command::new("kill").args(["-KILL", "--", &format!("-{}", child.id())]).status();
    let _ = child.kill();
    status.or_else(|| child.wait().ok())
}

impl Sidecar {
    /// App exit: close stdin (the sidecar leaves on EOF), give it a moment, then kill the group.
    fn stop(&self) {
        self.exiting.store(true, Ordering::SeqCst);
        drop(self.stdin.lock().ok().and_then(|mut s| s.take()));
        if let Some(child) = self.child.lock().ok().and_then(|mut c| c.take()) {
            reap(child, 1500);
        }
    }
}

#[tauri::command]
fn pi_send(state: State<'_, Sidecar>, line: String) -> Result<(), String> {
    let mut stdin = state.stdin.lock().map_err(|e| e.to_string())?;
    let stdin = stdin.as_mut().ok_or("sidecar is not running")?;
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
fn sidecar_command(app: &AppHandle) -> Command {
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

/// Start a sidecar, hand its stdin/child to the state and pump its stdout into "pi:out".
fn start_sidecar(app: &AppHandle) -> std::io::Result<()> {
    let mut cmd = sidecar_command(app);
    // Own process group, so exit can take down everything the sidecar started.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn()?;
    let stdin = child.stdin.take().expect("sidecar stdin");
    let stdout = child.stdout.take().expect("sidecar stdout");
    eprintln!("[sidecar] spawned, pid={}", child.id());
    let state = app.state::<Sidecar>();
    *state.stdin.lock().unwrap() = Some(stdin);
    *state.child.lock().unwrap() = Some(child);

    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            if handle.emit("pi:out", line).is_err() {
                return;
            }
        }
        sidecar_died(&handle);
    });
    Ok(())
}

fn sidecar_died(app: &AppHandle) {
    let state = app.state::<Sidecar>();
    if state.exiting.load(Ordering::SeqCst) {
        return;
    }
    drop(state.stdin.lock().ok().and_then(|mut s| s.take()));
    let status = state.child.lock().ok().and_then(|mut c| c.take()).and_then(|c| reap(c, 1000));
    let why = match status.and_then(|s| s.code()) {
        Some(code) => format!("kod wyjścia {code}"),
        None => "zabity sygnałem".to_string(),
    };
    eprintln!("[sidecar] died: {why}");
    let now = std::time::Instant::now();
    let give_up = {
        let mut r = state.restarts.lock().unwrap();
        r.retain(|t| now.duration_since(*t) < std::time::Duration::from_secs(60));
        r.push(now);
        r.len() > 3
    };
    let _ = app.emit("pi:down", serde_json::json!({ "why": why, "restarting": !give_up }));
    if give_up {
        return;
    }
    std::thread::sleep(std::time::Duration::from_millis(500));
    match start_sidecar(app) {
        Ok(()) => {
            let _ = app.emit("pi:up", ());
        }
        Err(e) => {
            let _ = app.emit("pi:down", serde_json::json!({ "why": format!("nie da się uruchomić: {e}"), "restarting": false }));
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Links from chat open in the default browser; the capability scopes it to http(s)/mailto.
        .plugin(tauri_plugin_opener::init())
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
            app.manage(Sidecar {
                stdin: Mutex::new(None),
                child: Mutex::new(None),
                exiting: AtomicBool::new(false),
                restarts: Mutex::new(Vec::new()),
            });
            start_sidecar(app.handle()).expect("failed to spawn sidecar");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![pi_send, set_close_to_tray])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Tray "Zakończ", the last window closing, app.exit(): never leave the sidecar behind.
            if let tauri::RunEvent::Exit = event {
                app.state::<Sidecar>().stop();
            }
        });
}
