import type { ClientCommand, ClientCommandInput, SidecarOut } from "../../shared/protocol";

export interface PiTransport {
  send(cmd: ClientCommandInput): void;
  onMessage(cb: (msg: SidecarOut) => void): () => void;
  /** Fired on every (re)connect — safe point to send the boot sequence. */
  onOpen(cb: () => void): () => void;
  close(): void;
}

// Explicit per-variant construction: spreading a union does not preserve
// discriminant correlation, so TS rejects `{ ...cmd, id }` as ClientCommand.
export function withId(cmd: ClientCommandInput, id: number): ClientCommand {
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
    case "session_new":
      return { id, cmd: "session_new", cwd: cmd.cwd };
    case "history":
      return { id, cmd: "history" };
    case "dispose":
      return { id, cmd: "dispose" };
  }
}

/**
 * Dev transport: WebSocket to dev/ws-bridge.mjs (wraps sidecar stdio).
 * Reconnects with backoff when the bridge restarts; `onOpen` fires again
 * so the UI can re-send its boot sequence.
 */
export function createWsTransport(url: string): PiTransport {
  let ws: WebSocket | null = null;
  let nextId = 1;
  let intentional = false;
  let attempt = 0;
  const listeners = new Set<(m: SidecarOut) => void>();
  const openListeners = new Set<() => void>();

  function connect(): void {
    ws = new WebSocket(url);
    ws.onopen = () => {
      attempt = 0;
      openListeners.forEach((l) => l());
    };
    ws.onmessage = (e) => {
      let msg: SidecarOut;
      try {
        msg = JSON.parse(String(e.data)) as SidecarOut;
      } catch {
        return;
      }
      listeners.forEach((l) => l(msg));
    };
    ws.onclose = () => {
      if (intentional) return;
      const delay = Math.min(4000, 500 * 2 ** attempt++);
      setTimeout(connect, delay);
    };
  }
  connect();

  return {
    send(cmd) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(withId(cmd, nextId++)));
      }
    },
    onMessage(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    onOpen(cb) {
      openListeners.add(cb);
      return () => {
        openListeners.delete(cb);
      };
    },
    close() {
      intentional = true;
      ws?.close();
    },
  };
}
