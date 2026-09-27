import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSession, openSessionFile } from "./session-files";

const msg = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() });
const assistant = (text: string) =>
  ({ role: "assistant", content: [{ type: "text", text }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() }) as never;

/** A real session file on disk with one exchange. */
function realSession(dir: string): string {
  const sm = SessionManager.create("/w", dir);
  sm.appendMessage(msg("pierwsza"));
  sm.appendMessage(assistant("odpowiedź"));
  return sm.getSessionFile()!;
}

afterEach(() => {
  delete process.env.PI_GUI_EPHEMERAL;
});

describe("session files", () => {
  it("normally: real files", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-gui-sess-"));
    const sm = createSession("/w", dir);
    sm.appendMessage(msg("a"));
    sm.appendMessage(assistant("b"));
    expect(sm.isPersisted()).toBe(true);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("PI_GUI_EPHEMERAL: new sessions stay in memory, opened files are read but never written", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-gui-sess-"));
    const file = realSession(dir);
    const before = readFileSync(file, "utf8");
    process.env.PI_GUI_EPHEMERAL = "1";

    const fresh = createSession("/w", dir);
    fresh.appendMessage(msg("a"));
    fresh.appendMessage(assistant("b"));
    expect(fresh.isPersisted()).toBe(false);

    const opened = openSessionFile(file, dir);
    expect(opened.getCwd()).toBe("/w");
    expect(opened.buildSessionContext().messages).toHaveLength(2);
    opened.appendMessage(msg("dopisana"));
    opened.appendMessage(assistant("też"));
    expect(opened.buildSessionContext().messages).toHaveLength(4);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual([file.split("/").pop()]);
  });
});
