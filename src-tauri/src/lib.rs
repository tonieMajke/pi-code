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

/// WebKitGTK gives a paste event only `text/html` for a copied image, never the image itself
/// (WebKitGTK 2.52: a Firefox or Spectacle copy), so the UI asks here. Raw bytes of the first
/// image the clipboard offers, empty when it has none.
#[tauri::command]
async fn clipboard_image(app: AppHandle) -> Result<tauri::ipc::Response, String> {
    #[cfg(target_os = "linux")]
    {
        // GTK clipboard calls belong on the main thread; wait_for_* spins a nested loop there.
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(read_clipboard_image());
        })
        .map_err(|e| e.to_string())?;
        let bytes = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "clipboard: no answer".to_string())?;
        Ok(tauri::ipc::Response::new(bytes))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Ok(tauri::ipc::Response::new(Vec::new()))
    }
}

#[cfg(target_os = "linux")]
fn read_clipboard_image() -> Vec<u8> {
    use gtk::gdk;
    let clipboard = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
    let Some(targets) = clipboard.wait_for_targets() else {
        return Vec::new();
    };
    let offered: Vec<String> = targets.iter().map(|a| a.name().to_string()).collect();
    for want in ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"] {
        if !offered.iter().any(|t| t == want) {
            continue;
        }
        if let Some(sel) = clipboard.wait_for_contents(&gdk::Atom::intern(want)) {
            let bytes = sel.data();
            if !bytes.is_empty() {
                return bytes;
            }
        }
    }
    Vec::new()
}

const IMAGE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

/// An image picked in the native dialog or dropped on the window. Tauri takes file drops
/// itself (the page gets no `drop`); the picker is the dialog plugin, as for project folders.
#[tauri::command]
async fn read_image_file(path: String) -> Result<tauri::ipc::Response, String> {
    let p = std::path::Path::new(&path);
    let ext = p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("not an image: {path}"));
    }
    let len = std::fs::metadata(p).map_err(|e| e.to_string())?.len();
    if len > 64 << 20 {
        return Err(format!("too big ({} MB): {path}", len >> 20));
    }
    std::fs::read(p).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

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

/// Why the sidecar never started: facts only, the UI words them (`startupProblemText`) in its
/// language. `Display` is for the log. `from_env` = the only candidate was `$PI_CODE_NODE`, so
/// the fix is that variable, not installing node.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StartupProblem {
    /// None of the candidates runs and answers `--version` like node does.
    NodeMissing { node: String, required: String, from_env: bool },
    /// A node runs, but its version is too old.
    NodeTooOld { node: String, detected: String, required: String, from_env: bool },
    /// node is fine, the spawn itself failed.
    Spawn { error: String },
}

impl std::fmt::Display for StartupProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartupProblem::NodeMissing { node, required, .. } => {
                write!(f, "no Node.js (checked: {node}), Node {required} or newer is needed")
            }
            StartupProblem::NodeTooOld { node, detected, required, .. } => {
                write!(f, "Node {detected} ({node}) is too old, Node {required} or newer is needed")
            }
            StartupProblem::Spawn { error } => write!(f, "cannot start the sidecar: {error}"),
        }
    }
}

/// First candidate that runs and reports at least `MIN_NODE`; `probe` is its `node --version`
/// (None = the binary is not there, does not run or hangs). Output that is not a node version
/// (`PI_CODE_NODE` pointing at python) counts as no node. When only old ones are left, the last
/// of them names the version in the message.
pub fn pick_node<S: AsRef<str>, P: Fn(&str) -> Option<String>>(
    candidates: &[S],
    from_env: bool,
    probe: P,
) -> Result<usize, StartupProblem> {
    let required = version_text(MIN_NODE);
    let mut checked: Vec<String> = Vec::new();
    let mut too_old: Option<(String, String)> = None;
    for (i, c) in candidates.iter().enumerate() {
        let bin = c.as_ref();
        let raw = probe(bin);
        match raw.as_deref().map(str::trim).and_then(|r| parse_node_version(r).map(|v| (r, v))) {
            Some((_, v)) if v >= MIN_NODE => return Ok(i),
            Some((r, _)) => too_old = Some((bin.to_string(), r.to_string())),
            None => checked.push(bin.to_string()),
        }
    }
    match too_old {
        Some((node, detected)) => Err(StartupProblem::NodeTooOld { node, detected, required, from_env }),
        None => Err(StartupProblem::NodeMissing { node: checked.join(", "), required, from_env }),
    }
}

/// `bin --version`, given up after `NODE_PROBE_MS`: this runs in `setup`, before the window shows,
/// so a binary that hangs must not keep the app from starting.
const NODE_PROBE_MS: u64 = 3000;

fn node_version_probe(bin: &str) -> Option<String> {
    let mut child = Command::new(bin)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(NODE_PROBE_MS);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(10))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut out).ok()?;
    Some(out.trim().to_string())
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

/// The tray menu items, so the UI can word them in its language (`set_tray_labels`); None when
/// there is no tray.
pub struct TrayItems(Mutex<Option<[MenuItem<tauri::Wry>; 2]>>);

/// Rust does not know the UI language: the UI sends the two labels through `t()`.
#[tauri::command]
fn set_tray_labels(state: State<'_, TrayItems>, show: String, quit: String) {
    if let Some([s, q]) = state.0.lock().ok().as_deref().and_then(Option::as_ref) {
        let _ = s.set_text(show);
        let _ = q.set_text(quit);
    }
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
    if let Ok(mut items) = app.state::<TrayItems>().0.lock() {
        *items = Some([show, quit]);
    }
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

/// Which node runs the sidecar: `$PI_CODE_NODE` alone when the user points at one (an explicit
/// choice that does not work is reported, not silently replaced), else the node bundled in the
/// app resources, if any, with the system `node` as the fallback. Each candidate must report at
/// least [`MIN_NODE`].
fn node_program(app: &AppHandle) -> Result<String, StartupProblem> {
    let mut candidates: Vec<String> = Vec::new();
    let from_env = matches!(std::env::var_os("PI_CODE_NODE"), Some(ref p) if !p.is_empty());
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
    let i = pick_node(&candidates, from_env, node_version_probe)?;
    Ok(candidates.swap_remove(i))
}

/// Dev: `pnpm sidecar` (tsx) from the project root. Release (AppImage): the esbuild bundle
/// from the app resources, run by [`node_program`].
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
        .map_err(|e| StartupProblem::Spawn { error: format!("resource dir: {e}") })?;
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
    let code = status.and_then(|s| s.code());
    let why = match code {
        Some(code) => format!("exit code {code}"),
        None => "killed by a signal".to_string(),
    };
    eprintln!("[sidecar] died: {why}");
    let now = std::time::Instant::now();
    let give_up = {
        let mut r = state.restarts.lock().unwrap();
        r.retain(|t| now.duration_since(*t) < std::time::Duration::from_secs(60));
        r.push(now);
        r.len() > 3
    };
    // `code` is the fact the UI words in its own language; `why` stays for older UIs and the log.
    let _ = app.emit("pi:down", serde_json::json!({ "why": why, "code": code, "restarting": !give_up }));
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
            let _ = app.emit("pi:down", serde_json::json!({ "why": e.to_string(), "startup": e, "restarting": false }));
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
        .manage(TrayItems(Mutex::new(None)))
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
        .invoke_handler(tauri::generate_handler![
            pi_send,
            set_close_to_tray,
            set_tray_labels,
            pi_startup_problem,
            clipboard_image,
            read_image_file
        ])
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
        assert!(matches!(pick_node(&["/opt/node/bin/node", "node"], false, &p), Ok(0)));
    }

    /// A bundled node that does not run (wrong arch, broken image) leaves the system one.
    #[test]
    fn skips_a_candidate_that_does_not_run() {
        let p = probe(&[("node", "v22.20.0")]);
        assert!(matches!(pick_node(&["/nie/ma", "node"], false, &p), Ok(1)));
    }

    /// `PI_CODE_NODE=/usr/bin/python3`: whatever it prints is not a node version.
    #[test]
    fn output_that_is_not_a_node_version_is_no_node() {
        let p = probe(&[("/usr/bin/python3", "Python 3.12.4")]);
        let err = pick_node(&["/usr/bin/python3"], true, &p).unwrap_err();
        assert!(
            matches!(err, StartupProblem::NodeMissing { ref node, from_env: true, .. } if node == "/usr/bin/python3"),
            "{err:?}"
        );
    }

    #[test]
    fn reports_a_node_that_is_too_old() {
        let p = probe(&[("node", "v20.0.0")]);
        let err = pick_node(&["node"], false, &p).unwrap_err();
        assert!(matches!(err, StartupProblem::NodeTooOld { from_env: false, .. }));
        let text = err.to_string();
        assert!(text.contains("20.0.0") && text.contains("22.19.0"), "{text}");
    }

    #[test]
    fn reports_no_node_at_all() {
        let err = pick_node(&["/nie/ma"], false, &probe(&[])).unwrap_err();
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

        let old = pick_node(&[fake.to_str().unwrap()], true, node_version_probe).unwrap_err();
        assert!(matches!(old, StartupProblem::NodeTooOld { ref detected, .. } if detected == "v20.0.0"), "{old}");
        assert!(old.to_string().contains("22.19.0"), "{old}");

        let none = pick_node(&[absent.to_str().unwrap()], true, node_version_probe).unwrap_err();
        assert!(matches!(none, StartupProblem::NodeMissing { .. }), "{none}");

        // The old one is skipped when a newer one stands next to it.
        let ok = pick_node(&[fake.to_str().unwrap(), "/usr/bin/true"], false, |bin| {
            (bin == "/usr/bin/true").then(|| "v22.19.0".to_string())
        });
        assert!(matches!(ok, Ok(1)));

        // A binary that never answers is given up on, not waited for: setup would hang with it.
        let hang = dir.join("hang");
        std::fs::write(&hang, "#!/bin/sh\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&hang, std::fs::Permissions::from_mode(0o755)).unwrap();
        let started = std::time::Instant::now();
        assert_eq!(node_version_probe(hang.to_str().unwrap()), None);
        assert!(started.elapsed() < std::time::Duration::from_secs(10), "{:?}", started.elapsed());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
