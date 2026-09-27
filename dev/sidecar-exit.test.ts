import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRATCH = mkdtempSync(join(tmpdir(), "pi-gui-exit-"));

/** Is anything left in the process group (the sidecar and whatever it started)? */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("sidecar lifetime", () => {
  // After `init` extensions and MCP servers hold the event loop: closing stdin used to leave
  // the sidecar running for good, one orphan per app exit.
  it("leaves within ~2 s after stdin closes, init or not", async () => {
    const child = spawn(join(ROOT, "node_modules/.bin/tsx"), ["sidecar/src/main.ts"], {
      cwd: ROOT,
      env: {
        ...process.env,
        PI_GUI_EPHEMERAL: "1",
        PI_GUI_CONFIG: join(SCRATCH, "pi-gui.json"),
        PI_GUI_MEMORY: join(SCRATCH, "memory"),
        PI_GUI_STATS: join(SCRATCH, "stats.jsonl"),
        PI_GUI_SIDEBAR: join(SCRATCH, "sidebar.json"),
        PI_GUI_VOICE_KEYS: join(SCRATCH, "voice-keys.json"),
      },
      stdio: ["pipe", "pipe", "ignore"],
      detached: true,
    });
    const pgid = child.pid!;
    try {
      let out = "";
      const initDone = new Promise<void>((resolve) =>
        child.stdout.on("data", (d) => {
          out += String(d);
          if (/"id":1,.*"ok":true/.test(out)) resolve();
        }),
      );
      child.stdin.write(`${JSON.stringify({ id: 1, cmd: "init", cwd: SCRATCH })}\n`);
      await initDone;

      const exited = new Promise<number>((resolve) => child.on("exit", () => resolve(Date.now())));
      const closedAt = Date.now();
      child.stdin.end();
      const at = await Promise.race([exited, new Promise<number>((r) => setTimeout(() => r(-1), 5000))]);
      expect(at).toBeGreaterThan(0);
      expect(at - closedAt).toBeLessThan(2500);
      await new Promise((r) => setTimeout(r, 300));
      expect(groupAlive(pgid)).toBe(false);
    } finally {
      if (groupAlive(pgid)) process.kill(-pgid, "SIGKILL");
    }
  }, 120000);
});
