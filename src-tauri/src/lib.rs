use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

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

fn log_sidecar_started(_app: &tauri::App) {
    eprintln!("[sidecar] spawned, cwd={:?}", std::env::current_dir().ok());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
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
        .invoke_handler(tauri::generate_handler![pi_send])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
