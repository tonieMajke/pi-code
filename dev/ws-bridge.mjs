import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";

/**
 * Dev bridge: wraps the sidecar's stdio JSONL with a local WebSocket,
 * so the React UI can be developed in a browser against the real sidecar.
 * In the Tauri shell the same sidecar is spawned in-process (no WS).
 */
const PORT = process.env.PORT ? Number(process.env.PORT) : 9876;
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
    if (line.trim()) wss.clients.forEach((c) => c.readyState === 1 && c.send(line));
  }
});

sidecar.on("exit", (code) => {
  console.error(`sidecar exited: ${code}`);
  process.exit(code ?? 0);
});

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    const line = data.toString();
    if (line.trim()) sidecar.stdin.write(`${line}\n`);
  });
});

console.error(`ws bridge on ws://127.0.0.1:${PORT}`);
