import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { HistoryItem } from "../shared/protocol";
import WebSocket from "ws";

const PORT = 9899;
const ROOT = fileURLToPath(new URL("..", import.meta.url));

interface Out {
  id?: number;
  ok?: boolean;
  error?: string;
  result?: unknown;
  event?: { kind: string };
}

/** Open a WS, retrying while the freshly spawned bridge is not listening yet. */
async function connect(deadlineMs = 20000): Promise<WebSocket> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    try {
      return await new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
      });
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** Connect a WS client, collect messages until `until` matches or timeout. */
async function client(): Promise<{ ws: WebSocket; msgs: Out[]; until: (p: (m: Out) => boolean, ms?: number) => Promise<Out[]> }> {
  const ws = await connect();
  const msgs: Out[] = [];
  const waiters: { pred: (m: Out) => boolean; resolve: (r: Out[]) => void }[] = [];
  ws.on("message", (data) => {
    let m: Out;
    try {
      m = JSON.parse(String(data)) as Out;
    } catch {
      return; // non-protocol line; the real transports skip these too
    }
    msgs.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) {
        const [w] = waiters.splice(i, 1);
        w.resolve([...msgs]);
      }
    }
  });
  function until(pred: (m: Out) => boolean, ms = 120000): Promise<Out[]> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for event; got ${msgs.length} msgs`)), ms);
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (pred(msgs[i])) {
          clearTimeout(t);
          return resolve([...msgs]);
        }
      }
      waiters.push({ pred, resolve: (r) => (clearTimeout(t), resolve(r)) });
    });
  }
  return { ws, msgs, until };
}

describe("e2e smoke: bridge + sidecar over WS", () => {
  it("init → prompt → settled → history", async () => {
    // detached => own process group, so we can kill bridge AND the sidecar it spawned
    const bridge = spawn("node", ["dev/ws-bridge.mjs"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "ignore", "inherit"],
      detached: true,
    });
    const c = await client();
    const send = (o: Record<string, unknown>) => c.ws.send(JSON.stringify(o));
    try {
      // init
      send({ id: 1, cmd: "init", cwd: ROOT });
      await c.until((m) => m.event?.kind === "init_done");
      const initOk = await c.until((m) => m.id === 1 && m.ok === true);
      expect(initOk.some((m) => m.id === 1 && m.ok)).toBe(true);

      // prompt — the local model should answer one word
      send({ id: 2, cmd: "prompt", text: "Odpowiedz dokładnie jednym słowem: gotowe" });
      await c.until((m) => m.event?.kind === "settled", 300000);
      expect(c.msgs.some((m) => m.event?.kind === "text_delta")).toBe(true);

      // history contains the exchange
      send({ id: 3, cmd: "history" });
      await c.until((m) => m.id === 3 && m.ok === true);
      const history = c.msgs.find((m) => m.id === 3)?.result as HistoryItem[] | undefined;
      expect(Array.isArray(history)).toBe(true);
      expect(history!.some((i) => i.role === "user" && i.text.includes("gotowe"))).toBe(true);
      expect(
        history!.some((i) => i.role === "assistant" && i.parts.some((p) => p.type === "text" && p.text.length > 0)),
      ).toBe(true);
    } finally {
      c.ws.close();
      if (bridge.pid) {
        try {
          process.kill(-bridge.pid, "SIGKILL"); // whole group: bridge + sidecar
        } catch {
          bridge.kill("SIGKILL");
        }
      }
    }
  }, 400000);
});
