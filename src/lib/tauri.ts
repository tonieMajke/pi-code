import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SidecarOut } from "../../shared/protocol";
import { withId, type PiTransport } from "./transport";

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
