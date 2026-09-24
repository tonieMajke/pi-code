import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";

/**
 * Dev bridge: wraps the sidecar's stdio JSONL with a local WebSocket,
 * so the React UI can be developed in a browser against the real sidecar.
 * In the Tauri shell the same sidecar is spawned in-process (no WS).
 */
const PORT = process.env.PORT ? Number(process.env.PORT) : 9877;
const CWD = process.env.CWD;

const sidecar = spawn("pnpm", ["sidecar"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, ...(CWD ? { PI_GUI_CWD: CWD } : {}) },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
sidecar.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.trim()) accepted.forEach((c) => c.readyState === 1 && c.send(line));
  }
});

sidecar.on("exit", (code) => {
  console.error(`sidecar exited: ${code}`);
  process.exit(code ?? 0);
});

/**
 * One window per bridge. A second client (a headless browser a model started, another tab) would
 * drive the same sidecar and its live session — that is how a demo prompt once landed in a real
 * session. It is refused; the UI keeps retrying and gets in once the first window is gone.
 * PI_GUI_BRIDGE_SHARED=1 allows several windows on purpose.
 */
const SHARED = process.env.PI_GUI_BRIDGE_SHARED === "1";
/** Clients that may talk to the sidecar and hear from it. */
const accepted = new Set();
const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
wss.on("connection", (ws) => {
  const held = [];
  const forward = (line) => line.trim() && sidecar.stdin.write(`${line}\n`);
  const admit = () => {
    accepted.add(ws);
    held.splice(0).forEach(forward);
  };
  ws.on("close", () => accepted.delete(ws));
  ws.on("message", (data) => (accepted.has(ws) ? forward(data.toString()) : held.push(data.toString())));
  if (SHARED || accepted.size === 0) return admit();
  // A page reload closes the old socket a moment after the new one opens: wait before refusing.
  setTimeout(() => {
    if (ws.readyState !== 1) return;
    if ([...accepted].every((c) => c.readyState !== 1)) return admit();
    console.error(`ws bridge :${PORT}: refused a second window; start your own bridge (PORT=… CWD=… node dev/ws-bridge.mjs)`);
    ws.close(4001, "bridge in use by another window");
  }, 1000);
});

console.error(`ws bridge on ws://127.0.0.1:${PORT}`);
