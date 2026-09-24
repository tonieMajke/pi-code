import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConstitutionGuard, DEFAULT_CONSTITUTION, isCheckCommand } from "./constitution.js";
import { GuiConfigStore, defaultToolPolicy } from "./config.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pi-gui-const-"));
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  const g = new ConstitutionGuard(() => dir);
  g.startRun();
  return { dir, g };
}

describe("isCheckCommand", () => {
  it.each(["pnpm test", "npx vitest run", "cargo check", "tsc --noEmit", "python3 main.py", "./build.sh", "make", "git diff"])(
    "counts %s",
    (cmd) => expect(isCheckCommand(cmd)).toBe(true),
  );
  it.each(["ls -la", "cat a.ts", "grep foo -r .", "mkdir x", "echo hi"])("does not count %s", (cmd) =>
    expect(isCheckCommand(cmd)).toBe(false),
  );
});

describe("ConstitutionGuard", () => {
  it("blocks editing an existing file that was not read, allows it after read", () => {
    const { g } = setup();
    expect(g.beforeTool("edit", { path: "a.ts", edits: [] })).toMatch(/read a\.ts before editing/);
    g.afterTool("read", { path: "a.ts" }, false);
    expect(g.beforeTool("edit", { path: "a.ts", edits: [] })).toBeNull();
  });

  it("lets write create a new file without reading", () => {
    const { g } = setup();
    expect(g.beforeTool("write", { path: "new.ts", content: "x" })).toBeNull();
  });

  it("blocks a third identical call after two failures", () => {
    const { g } = setup();
    const input = { command: "pnpm test" };
    g.afterTool("bash", input, true);
    expect(g.beforeTool("bash", input)).toBeNull();
    g.afterTool("bash", input, true);
    expect(g.beforeTool("bash", input)).toMatch(/twice and it failed/);
  });

  it("sends the model back after an unverified code edit, not after a verified one", () => {
    const { g } = setup();
    g.afterTool("read", { path: "a.ts" }, false);
    g.afterTool("edit", { path: "a.ts" }, false);
    expect(g.beforeSettle(2)).toMatchObject({ content: expect.stringMatching(/You changed a\.ts/) });
    g.afterTool("bash", { command: "pnpm test" }, false);
    expect(g.beforeSettle(2)).toBeNull();
  });

  it("flags a failing last check, and stops nudging at the limit", () => {
    const { g } = setup();
    g.afterTool("write", { path: "b.ts" }, false);
    g.afterTool("bash", { command: "pnpm test" }, true);
    expect(g.beforeSettle(1)).toMatchObject({ content: expect.stringMatching(/last check failed/) });
    // limit reached: no more nudges, the run is reported as stuck instead
    expect(g.beforeSettle(1)).toMatchObject({ stuck: expect.stringMatching(/nie przeszło/) });
  });

  it("ignores a failing git diff after a passing check", () => {
    const { g } = setup();
    g.afterTool("write", { path: "b.ts" }, false);
    g.afterTool("bash", { command: "python3 -c 'import b'" }, false);
    g.afterTool("bash", { command: "git diff -- b.ts" }, true);
    expect(g.beforeSettle(2)).toBeNull();
  });

  it("requires looking at visual changes; any image result counts", () => {
    const { g } = setup();
    g.afterTool("write", { path: "page.css" }, false);
    g.afterTool("bash", { command: "npx stylelint page.css" }, false);
    expect(g.beforeSettle(3)).toMatchObject({ content: expect.stringMatching(/You changed page\.css but have not looked/) });
    g.afterTool("look", { target: "page.html" }, false, true);
    expect(g.beforeSettle(3)).toBeNull();
  });

  it("accepts a look after the last change as the check for visual-only edits", () => {
    const { g } = setup();
    g.afterTool("write", { path: "index.html" }, false);
    g.afterTool("look", { target: "index.html" }, false, true);
    expect(g.beforeSettle(3)).toBeNull();
  });

  it("treats mutating Blender/Blockbench MCP calls as visual, screenshots as looking", () => {
    const { g } = setup();
    g.afterTool("mcp", { tool: "blender_execute_blender_code", args: {} }, false);
    expect(g.beforeSettle(3)).toMatchObject({ content: expect.stringMatching(/the Blender scene/) });
    g.afterTool("mcp", { tool: "blender_get_viewport_screenshot" }, false, true);
    expect(g.beforeSettle(3)).toBeNull();
    g.afterTool("mcp", { tool: "blockbench_list_outline" }, false);
    expect(g.beforeSettle(3)).toBeNull();
  });

  it("does not require a check for prose-only edits", () => {
    const { g } = setup();
    g.afterTool("write", { path: "README.md" }, false);
    expect(g.beforeSettle(2)).toBeNull();
  });

  it("resets per-run state on a new prompt but remembers read files", () => {
    const { g } = setup();
    g.afterTool("read", { path: "a.ts" }, false);
    g.afterTool("edit", { path: "a.ts" }, false);
    g.startRun();
    expect(g.beforeSettle(2)).toBeNull();
    expect(g.beforeTool("edit", { path: "a.ts" })).toBeNull();
  });
});

describe("GuiConfigStore", () => {
  it("defaults, persists next to other keys, and falls back to the built-in text", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-gui-store-"));
    const file = join(dir, "pi-gui.json");
    writeFileSync(file, JSON.stringify({ other: 1 }));
    const store = new GuiConfigStore(file);
    expect(store.get().constitution).toMatchObject({ enabled: true, hard: true });
    expect(store.constitutionText).toBe(DEFAULT_CONSTITUTION);
    store.update("constitution", { hard: false, text: "Be careful." });
    store.update("sampling", { enabled: true, temperature: 0.3 });
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.other).toBe(1);
    const again = new GuiConfigStore(file);
    expect(again.get().constitution).toMatchObject({ hard: false, text: "Be careful." });
    expect(again.get().sampling).toMatchObject({ enabled: true, temperature: 0.3, top_p: null });
    expect(again.constitutionText).toBe("Be careful.");
  });

  it("stores only tool policies that differ from the default", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-gui-store-"));
    const store = new GuiConfigStore(join(dir, "pi-gui.json"));
    expect(defaultToolPolicy("read")).toBe("always");
    expect(defaultToolPolicy("subagent")).toBe("deferred");
    expect(defaultToolPolicy("powershell")).toBe("off");
    store.setToolPolicy("subagent", "always");
    store.setToolPolicy("read", "always");
    expect(store.get().tools).toEqual({ subagent: "always" });
    store.setToolPolicy("subagent", "deferred");
    expect(store.get().tools).toEqual({});
  });
});
