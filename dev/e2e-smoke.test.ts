import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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

/** Connect a WS client, collect messages until `until` matches or timeout. */
function client(): Promise<{ ws: WebSocket; msgs: Out[]; until: (p: (m: Out) => boolean, ms?: number) => Promise<Out[]> }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const msgs: Out[] = [];
    const waiters: { pred: (m: Out) => boolean; resolve: (r: Out[]) => void }[] = [];
    ws.on("open", () => resolve({ ws, msgs, until }));
    ws.on("message", (data) => {
      const m = JSON.parse(String(data)) as Out;
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
  });
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
      const history = c.msgs.find((m) => m.id === 3)?.result as
        | { role: string; text: string }[]
        | undefined;
      expect(Array.isArray(history)).toBe(true);
      expect(history!.some((i) => i.role === "user" && i.text.includes("gotowe"))).toBe(true);
      expect(history!.some((i) => i.role === "assistant" && i.text.length > 0)).toBe(true);
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
