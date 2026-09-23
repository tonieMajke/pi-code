import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ClientCommand, ClientCommandInput, SidecarOut } from "../../shared/protocol";

export interface PiTransport {
  send(cmd: ClientCommandInput): void;
  onMessage(cb: (msg: SidecarOut) => void): () => void;
  onOpen(cb: () => void): () => void;
  close(): void;
}

// Explicit per-variant construction (union spread breaks discriminant correlation).
function withId(cmd: ClientCommandInput, id: number): ClientCommand {
  switch (cmd.cmd) {
    case "init":
      return { id, cmd: "init", cwd: cmd.cwd, sessionFile: cmd.sessionFile };
    case "prompt":
      return { id, cmd: "prompt", text: cmd.text, behavior: cmd.behavior };
    case "abort":
      return { id, cmd: "abort" };
    case "status":
      return { id, cmd: "status" };
    case "sessions_list":
      return { id, cmd: "sessions_list", cwd: cmd.cwd };
    case "session_open":
      return { id, cmd: "session_open", path: cmd.path };
    case "history":
      return { id, cmd: "history" };
    case "dispose":
      return { id, cmd: "dispose" };
  }
}

/**
 * In-app transport: the Rust shell spawns the sidecar directly (stdio),
 * so no WebSocket is needed. "pi:out" events carry one JSONL line each.
 */
export function createTauriTransport(): PiTransport {
  let nextId = 1;
  let unlisten: (() => void) | null = null;
  const listeners = new Set<(m: SidecarOut) => void>();
  const openListeners = new Set<() => void>();

  void listen<string>("pi:out", (event) => {
    let msg: SidecarOut;
    try {
      msg = JSON.parse(event.payload) as SidecarOut;
    } catch {
      return;
    }
    listeners.forEach((l) => l(msg));
  })
    .then((off) => {
      unlisten = off;
      openListeners.forEach((l) => l());
    })
    .catch(() => undefined);

  return {
    send(cmd) {
      void invoke("pi_send", { line: JSON.stringify(withId(cmd, nextId++)) }).catch(() => undefined);
    },
    onMessage(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    onOpen(cb) {
      openListeners.add(cb);
      if (unlisten) cb(); // listener already armed
      return () => {
        openListeners.delete(cb);
      };
    },
    close() {
      unlisten?.();
      unlisten = null;
    },
  };
}

/** True when running inside the Tauri webview. */
export function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
