import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SidecarOut } from "../../shared/protocol";
import { t } from "../../shared/i18n";
import { withId, type PiTransport, type SidecarDown } from "./transport";
import type { StartupProblem } from "./startup";

export { startupProblemText, type StartupProblem } from "./startup";

/**
 * The Rust shell records why the sidecar never started (no node, node too old, spawn failed).
 * It ships the facts, not the sentence, so this is where the text gets translated.
 */
/** Ask the shell for a start failure; null when the sidecar came up (or we are not in Tauri). */
export function readStartupProblem(): Promise<StartupProblem | null> {
  return invoke<StartupProblem | null>("pi_startup_problem").catch(() => null);
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
  const downListeners = new Set<(d: SidecarDown) => void>();
  const offs: Promise<() => void>[] = [];

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
  // The Rust shell restarts a sidecar that died: pi:down now, pi:up once the new one runs.
  offs.push(listen<SidecarDown>("pi:down", (e) => downListeners.forEach((l) => l(e.payload))));
  offs.push(listen("pi:up", () => openListeners.forEach((l) => l())));

  return {
    send(cmd) {
      // A failed write means the sidecar is gone; pi:down reports it.
      void invoke("pi_send", { line: JSON.stringify(withId(cmd, nextId++)) }).catch((e) => console.warn("pi_send:", e));
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
    onDown(cb) {
      downListeners.add(cb);
      return () => {
        downListeners.delete(cb);
      };
    },
    close() {
      unlisten?.();
      unlisten = null;
      offs.forEach((p) => void p.then((off) => off()).catch(() => undefined));
    },
  };
}

/** True when running inside the Tauri webview. */
export function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
