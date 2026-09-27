import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../shared/protocol";
import { orphanSidecars, testReason } from "./cleanup";

const s = (cwd: string, firstMessage: string, messageCount = 2): SessionSummary => ({ path: "/p", id: "i", cwd, modified: "", messageCount, firstMessage });

describe("cleanup: test sessions", () => {
  it("flags /tmp, the e2e prompt and short one-word pings, not real work", () => {
    expect(testReason(s("/tmp/claude-1000/x/scratchpad", "zrób coś"))).toBe("katalog tymczasowy");
    expect(testReason(s("/home/u/pi-gui", "Odpowiedz dokładnie jednym słowem: gotowe"))).toBe("test e2e");
    expect(testReason(s("/home/u/x", "Powiedz jednym słowem: OK."))).toBe("krótki test modelu");
    expect(testReason(s("/home/u/x", "Powiedz OK."))).toBe("krótki test modelu");
    expect(testReason(s("/home/u/x", "Powiedz jednym słowem: OK.", 30))).toBeNull(); // it turned into a conversation
    expect(testReason(s("/home/u/x", "Dodaj do total() obsługę rabatu"))).toBeNull();
  });
});

describe("cleanup: orphaned sidecars", () => {
  const P = (pid: number, ppid: number, args: string) => ({ pid, ppid, started: "Sun Sep 27 12:00:00 2026", args });
  const procs = [
    P(1, 0, "/sbin/init"),
    P(900, 1, "/usr/lib/systemd/systemd --user"),
    // left behind: pnpm → tsx → node under the user's systemd
    P(10, 900, "node /usr/bin/pnpm sidecar"),
    P(11, 10, "node /x/node_modules/.bin/../tsx/dist/cli.mjs sidecar/src/main.ts"),
    P(12, 11, "/usr/bin/node --require /x/preflight.cjs --import file:///x/loader.mjs sidecar/src/main.ts"),
    P(13, 12, "uvx blender-mcp"),
    // alive: the dev bridge still has it
    P(20, 900, "node dev/ws-bridge.mjs"),
    P(21, 20, "node /usr/bin/pnpm sidecar"),
    // AppImage sidecar whose app died → init
    P(30, 1, "node /tmp/.mount_PiCode/usr/lib/Pi Code/sidecar/dist/main.mjs"),
    // this sidecar
    P(40, 900, "node /usr/bin/pnpm sidecar"),
    P(41, 40, "/usr/bin/node sidecar/src/main.ts"),
  ];
  it("reports the top of each abandoned tree with all its sidecar pids; never itself", () => {
    expect(orphanSidecars(procs, 41).map((o) => [o.pid, o.pids])).toEqual([
      [10, [10, 11, 12]],
      [30, [30]],
    ]);
  });
});
