import readline from "node:readline";
import { PiGateway } from "./gateway.js";
import type { ClientCommand, SidecarOut } from "../../shared/protocol.js";

const gateway = new PiGateway();

function out(msg: SidecarOut): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id: number, ok: boolean, result?: unknown, error?: string): void {
  out(ok ? { id, ok: true, result } : { id, ok: false, error: error ?? "unknown error" });
}

const KNOWN = new Set([
  "init",
  "prompt",
  "abort",
  "status",
  "sessions_list",
  "session_open",
  "history",
  "dispose",
]);

async function handle(cmd: ClientCommand): Promise<void> {
  if (!KNOWN.has(cmd.cmd)) {
    reply(cmd.id, false, undefined, `unknown command: ${cmd.cmd}`);
    return;
  }
  try {
    switch (cmd.cmd) {
      case "init":
        if (!gateway.ready) await gateway.init((e) => out({ event: e }), cmd.cwd);
        reply(cmd.id, true, { ready: true });
        return;
      case "prompt":
        if (!gateway.ready) throw new Error("not initialized — send init first");
        // prompt resolves when the run finishes; reply only then (UI tracks via events).
        await gateway.prompt(cmd.text, cmd.behavior);
        reply(cmd.id, true, { done: true });
        return;
      case "abort":
        await gateway.abort();
        reply(cmd.id, true, { done: true });
        return;
      case "status":
        reply(cmd.id, true, { busy: gateway.busy, ready: gateway.ready });
        return;
      case "sessions_list":
        reply(cmd.id, true, await gateway.listSessions());
        return;
      case "session_open":
        await gateway.openSession((e) => out({ event: e }), cmd.path);
        reply(cmd.id, true, { done: true });
        return;
      case "history":
        if (!gateway.ready) throw new Error("not initialized — send init first");
        reply(cmd.id, true, gateway.history());
        return;
      case "dispose":
        gateway.dispose();
        reply(cmd.id, true, { done: true });
        return;
    }
  } catch (err) {
    reply(cmd.id, false, undefined, err instanceof Error ? err.message : String(err));
  }
}

const rl = readline.createInterface({ input: process.stdin });
// Commands must run serially: prompt() resolves only when the whole run finishes,
// and a second prompt queued behind an in-flight run would corrupt event order.
let chain: Promise<void> = Promise.resolve();
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let cmd: ClientCommand;
  try {
    cmd = JSON.parse(trimmed) as ClientCommand;
  } catch {
    reply(-1, false, undefined, "invalid JSON on stdin");
    return;
  }
  chain = chain.then(() => handle(cmd));
});

rl.on("close", () => {
  gateway.dispose();
  // No process.exit(): let pending stdout writes flush and the process end naturally.
});
