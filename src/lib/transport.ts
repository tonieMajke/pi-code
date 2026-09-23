import type { ClientCommand, ClientCommandInput, SidecarOut } from "../../shared/protocol";

export interface PiTransport {
  send(cmd: ClientCommandInput): void;
  onMessage(cb: (msg: SidecarOut) => void): () => void;
  close(): void;
}

/** Dev transport: WebSocket to dev/ws-bridge.mjs (wraps sidecar stdio). */
// Explicit per-variant construction: spreading a union does not preserve
// discriminant correlation, so TS rejects `{ ...cmd, id }` as ClientCommand.
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
    case "dispose":
      return { id, cmd: "dispose" };
  }
}

export function createWsTransport(url: string): PiTransport {
  const ws = new WebSocket(url);
  let nextId = 1;
  const listeners = new Set<(m: SidecarOut) => void>();

  ws.onmessage = (e) => {
    let msg: SidecarOut;
    try {
      msg = JSON.parse(String(e.data)) as SidecarOut;
    } catch {
      return;
    }
    listeners.forEach((l) => l(msg));
  };

  return {
    send(cmd) {
      if (ws.readyState !== WebSocket.OPEN) return;
      const id = nextId++;
      const full = withId(cmd, id);
      ws.send(JSON.stringify(full));
    },
    onMessage(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    close() {
      ws.close();
    },
  };
}
