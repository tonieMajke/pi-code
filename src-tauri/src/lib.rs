use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use serde::Serialize;
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

/// The sidecar runs the pi SDK, which needs Node >= 22.19.0 (`engines` in its package.json).
/// With an older node the sidecar dies on start, so the restart loop below buys nothing.
pub const MIN_NODE: (u32, u32, u32) = (22, 19, 0);

fn version_text(v: (u32, u32, u32)) -> String {
    format!("{}.{}.{}", v.0, v.1, v.2)
}

/// `node --version` prints `v22.19.0`; distro builds add a suffix (`v22.19.0-1.arch1`,
/// `v22.19.0-nightly20260101`), so the number is read up to the first `-`, `+` or space.
pub fn parse_node_version(raw: &str) -> Option<(u32, u32, u32)> {
    let core = raw
        .trim()
        .trim_start_matches(['v', 'V'])
        .split(['-', '+', ' ', '\n', '\r'])
        .next()?;
    let mut parts = core.split('.');
    let mut next = || parts.next().and_then(|p| p.parse::<u32>().ok());
    Some((next()?, next()?, next()?))
}

/// Why the sidecar never started. The UI translates it (`pi_startup_problem`); `Display` is the
/// one-line Polish text for the log and for `pi:down`.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StartupProblem {
    /// None of the node candidates runs.
    NodeMissing { node: String, required: String },
    /// A node runs, but its version is too old (or cannot be read).
    NodeTooOld { node: String, detected: String, required: String },
    /// node is fine, the spawn itself failed.
    Spawn { error: String },
}

impl std::fmt::Display for StartupProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartupProblem::NodeMissing { node, required } => {
                write!(f, "nie znaleziono Node.js (sprawdzono: {node}) — potrzebny Node {required}")
            }
            StartupProblem::NodeTooOld { node, detected, required } => {
                write!(f, "Node {detected} ({node}) jest za stary — potrzebny Node {required}")
            }
            StartupProblem::Spawn { error } => write!(f, "nie da się uruchomić: {error}"),
        }
    }
}

/// First candidate that runs and reports at least `MIN_NODE`; `probe` is its `node --version`
/// (None = the binary is not there or does not run). Such candidates are skipped, so a stale
/// `$PI_CODE_NODE` does not hide a working system node. When only old ones are left, the last of
/// them names the version in the message.
pub fn pick_node<S: AsRef<str>, P: Fn(&str) -> Option<String>>(candidates: &[S], probe: P) -> Result<usize, StartupProblem> {
    let required = version_text(MIN_NODE);
    let mut checked: Vec<String> = Vec::new();
    let mut too_old: Option<(String, String)> = None;
    for (i, c) in candidates.iter().enumerate() {
        let bin = c.as_ref();
        match probe(bin).as_deref().map(str::trim) {
            Some(raw) => match parse_node_version(raw) {
                Some(v) if v >= MIN_NODE => return Ok(i),
                _ => too_old = Some((bin.to_string(), raw.to_string())),
            },
            None => checked.push(bin.to_string()),
        }
    }
    match too_old {
        Some((node, detected)) => Err(StartupProblem::NodeTooOld { node, detected, required }),
        None => Err(StartupProblem::NodeMissing { node: checked.join(", "), required }),
    }
}

fn node_version_probe(bin: &str) -> Option<String> {
    let out = Command::new(bin)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Sidecar start failure, kept for the UI: `setup` runs before the webview starts listening, so
/// an event emitted there can be lost — the UI asks for this after it mounts.
pub struct Startup(Mutex<Option<StartupProblem>>);

#[tauri::command]
fn pi_startup_problem(state: State<'_, Startup>) -> Option<StartupProblem> {
    state.0.lock().ok().and_then(|s| s.clone())
}

fn record_problem(app: &AppHandle, problem: &StartupProblem) {
    if let Ok(mut s) = app.state::<Startup>().0.lock() {
        *s = Some(problem.clone());
    }
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
/// Which node runs the sidecar: `$PI_CODE_NODE` alone when the user points at one, else the node
/// bundled in the app resources (CI build, see `.github/workflows/release.yml`) with the system
/// `node` as the fallback. Each candidate must report at least [`MIN_NODE`].
fn node_program(app: &AppHandle) -> Result<String, StartupProblem> {
    let mut candidates: Vec<String> = Vec::new();
    match std::env::var_os("PI_CODE_NODE") {
        Some(p) if !p.is_empty() => candidates.push(p.to_string_lossy().into_owned()),
        _ => {
            if let Ok(res) = app.path().resource_dir() {
                let bundled = res.join("node").join("bin").join("node");
                if bundled.is_file() {
                    candidates.push(bundled.to_string_lossy().into_owned());
                }
            }
            candidates.push("node".to_string());
        }
    }
    let i = pick_node(&candidates, node_version_probe)?;
    Ok(candidates.swap_remove(i))
}

fn sidecar_command(app: &AppHandle) -> Result<Command, StartupProblem> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    if cfg!(debug_assertions) {
        let mut cmd = Command::new("pnpm");
        cmd.arg("sidecar").current_dir(cwd);
        return Ok(cmd);
    }
    let res = app
        .path()
        .resource_dir()
        .map_err(|e| StartupProblem::Spawn { error: format!("brak katalogu zasobów: {e}") })?;
    let mut cmd = Command::new(node_program(app)?);
    cmd.arg(res.join("sidecar/dist/main.mjs"));
    clean_sidecar_env(&mut cmd);
    // AppRun cds into the mounted image; $OWD is where the AppImage was started. From a menu
    // that is often "/", so fall back to the home folder.
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let owd = std::env::var_os("OWD").map(std::path::PathBuf::from).filter(|p| p.as_os_str() != "/");
    if let Some(dir) = owd.or(home) {
        cmd.current_dir(dir);
    }
    Ok(cmd)
}

/// Start a sidecar, hand its stdin/child to the state and pump its stdout into "pi:out".
fn start_sidecar(app: &AppHandle) -> Result<(), StartupProblem> {
    let mut cmd = sidecar_command(app)?;
    // Own process group, so exit can take down everything the sidecar started.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| StartupProblem::Spawn { error: e.to_string() })?;
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
            record_problem(app, &e);
            let _ = app.emit("pi:down", serde_json::json!({ "why": e.to_string(), "restarting": false }));
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
            app.manage(Startup(Mutex::new(None)));
            if let Err(e) = start_sidecar(app.handle()) {
                // No node, node too old, pnpm missing: the window stays up and the UI shows what
                // to do. This used to panic — on a machine without node the app died silently.
                eprintln!("[sidecar] start failed: {e}");
                record_problem(app.handle(), &e);
                show_main(app.handle());
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![pi_send, set_close_to_tray, pi_startup_problem])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Tray "Zakończ", the last window closing, app.exit(): never leave the sidecar behind.
            if let tauri::RunEvent::Exit = event {
                app.state::<Sidecar>().stop();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{node_version_probe, parse_node_version, pick_node, StartupProblem, MIN_NODE};
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    /// `node --version` for a table of known binaries; a binary not in the table does not run.
    fn probe(table: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let table: Vec<(String, String)> = table.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |bin| table.iter().find(|(k, _)| k == bin).map(|(_, v)| v.clone())
    }

    #[test]
    fn reads_node_version_output() {
        assert_eq!(parse_node_version("v22.19.0\n"), Some((22, 19, 0)));
        assert_eq!(parse_node_version("  v24.3.1-1.arch1 "), Some((24, 3, 1)));
        assert_eq!(parse_node_version("v22.20.0-nightly20260101"), Some((22, 20, 0)));
        assert_eq!(parse_node_version("Node.js v20.18.1"), None);
        assert_eq!(parse_node_version(""), None);
        assert_eq!(parse_node_version("v22"), None);
        // The floor itself is good, one patch below is not.
        assert!(parse_node_version("v22.19.0").unwrap() >= MIN_NODE);
        assert!(parse_node_version("v22.18.9").unwrap() < MIN_NODE);
    }

    #[test]
    fn picks_the_first_node_new_enough() {
        let p = probe(&[("/opt/node/bin/node", "v22.19.0"), ("node", "v26.1.0")]);
        assert!(matches!(pick_node(&["/opt/node/bin/node", "node"], &p), Ok(0)));
    }

    #[test]
    fn falls_back_to_system_node_when_pointed_at_nothing() {
        let p = probe(&[("node", "v22.20.0")]);
        assert!(matches!(pick_node(&["/nie/ma", "node"], &p), Ok(1)));
    }

    #[test]
    fn reports_a_node_that_is_too_old() {
        let p = probe(&[("node", "v20.0.0")]);
        let err = pick_node(&["node"], &p).unwrap_err();
        assert!(matches!(err, StartupProblem::NodeTooOld { .. }));
        let text = err.to_string();
        assert!(text.contains("20.0.0") && text.contains("22.19.0"), "{text}");
    }

    #[test]
    fn reports_no_node_at_all() {
        let err = pick_node(&["/nie/ma"], &probe(&[])).unwrap_err();
        assert!(matches!(err, StartupProblem::NodeMissing { .. }));
        assert!(err.to_string().contains("/nie/ma"), "{err}");
    }

    /// The same decisions with the real probe: a script that prints an old version, and a path
    /// with no binary behind it (what `PI_CODE_NODE=/nie/ma` looks like to the app).
    #[cfg(unix)]
    #[test]
    fn probes_binaries_it_can_run() {
        let dir = std::env::temp_dir().join(format!("pi-gui-node-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("node");
        std::fs::write(&fake, "#!/bin/sh\necho v20.0.0\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let absent = dir.join("nie-ma");

        let old = pick_node(&[fake.to_str().unwrap()], node_version_probe).unwrap_err();
        assert!(matches!(old, StartupProblem::NodeTooOld { ref detected, .. } if detected == "v20.0.0"), "{old}");
        assert!(old.to_string().contains("22.19.0"), "{old}");

        let none = pick_node(&[absent.to_str().unwrap()], node_version_probe).unwrap_err();
        assert!(matches!(none, StartupProblem::NodeMissing { .. }), "{none}");

        // The old one is skipped when a newer one stands next to it.
        let ok = pick_node(&[fake.to_str().unwrap(), "/usr/bin/true"], |bin| {
            (bin == "/usr/bin/true").then(|| "v22.19.0".to_string())
        });
        assert!(matches!(ok, Ok(1)));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
