import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TasteGuard, visualChange } from "./taste.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pi-gui-taste-"));
  const g = new TasteGuard(() => dir);
  g.startRun();
  return { dir, g };
}

const OPTS = { requireAudit: true, critic: true, maxRounds: 2, maxAuditNudges: 2 };
const bigWrite = (path: string) => ({ path, content: "x\n".repeat(40) });

describe("visualChange", () => {
  it("tells pages, pictures and logic apart", () => {
    expect(visualChange("write", bigWrite("index.html"))).toBe("ui");
    expect(visualChange("edit", { path: "a.css", edits: [] })).toBe("ui");
    expect(visualChange("write", bigWrite("logo.svg"))).toBe("image");
    expect(visualChange("write", { path: "App.tsx", content: 'export const A = () => <div className="x" />' })).toBe("ui");
    expect(visualChange("write", { path: "sum.tsx", content: "export const sum = (a: number) => a + 1" })).toBeNull();
    expect(visualChange("write", bigWrite("main.py"))).toBeNull();
    expect(visualChange("mcp", { tool: "blender_create_object", args: {} })).toBe("image");
    expect(visualChange("mcp", { tool: "blender_get_scene_info" })).toBeNull();
  });
});

describe("TasteGuard", () => {
  it("asks for references before the first real visual change, then lets it through", () => {
    const { g } = setup();
    expect(g.beforeTool("write", bigWrite("index.html"), "auto")).toMatch(/design_refs with kind "ui"/);
    g.afterTool("design_refs", { topic: "x", kind: "ui", query: "q" }, false);
    expect(g.beforeTool("write", bigWrite("index.html"), "auto")).toBeNull();
  });

  it("asks for image references before 3D work", () => {
    const { g } = setup();
    expect(g.beforeTool("mcp", { tool: "blockbench_add_cube" }, "auto")).toMatch(/kind "image"/);
  });

  it("never blocks small tweaks, logic, or when research is off / already done", () => {
    const { g } = setup();
    expect(g.beforeTool("edit", { path: "a.css", edits: [{ oldText: "a", newText: "color: red;" }] }, "auto")).toBeNull();
    expect(g.beforeTool("write", bigWrite("main.py"), "auto")).toBeNull();
    expect(g.beforeTool("write", bigWrite("index.html"), "off")).toBeNull();
    g.markResearched();
    expect(g.beforeTool("write", bigWrite("index.html"), "auto")).toBeNull();
  });

  it("blocks once per run, and never for diagrams", () => {
    const { g } = setup();
    expect(g.beforeTool("write", bigWrite("flow.mmd"), "auto")).toBeNull();
    expect(g.beforeTool("write", bigWrite("a.html"), "auto")).toMatch(/say why in one sentence and retry/);
    expect(g.beforeTool("write", bigWrite("a.html"), "auto")).toBeNull();
    g.startRun();
    expect(g.beforeTool("write", bigWrite("a.html"), "auto")).not.toBeNull();
  });

  it("wants a clean ui_audit after a page change, then a critic round", () => {
    const { g, dir } = setup();
    g.markResearched();
    g.afterTool("write", bigWrite("index.html"), false);
    const first = g.beforeSettle(OPTS);
    expect(first).toMatchObject({ kind: "nudge", nudge: { content: expect.stringMatching(/Run ui_audit on index\.html/) } });
    g.recordAudit(2);
    g.afterTool("ui_audit", { target: "index.html" }, false);
    expect(g.beforeSettle(OPTS)).toMatchObject({ kind: "nudge", nudge: { content: expect.stringMatching(/2 HIGH/) } });
    g.recordAudit(0);
    g.afterTool("ui_audit", { target: "index.html" }, false);
    expect(g.beforeSettle(OPTS)).toEqual({ kind: "critic", visual: "ui", target: join(dir, "index.html") });
  });

  it("stops after the critic says OK, and after the round limit", () => {
    const { g } = setup();
    g.afterTool("write", bigWrite("logo.svg"), false);
    expect(g.beforeSettle(OPTS)).toMatchObject({ kind: "critic", visual: "image" });
    expect(g.criticDone(false)).toEqual({ round: 1 });
    expect(g.beforeSettle(OPTS)).toBeNull(); // nothing changed since the critic looked
    g.afterTool("write", bigWrite("logo.svg"), false);
    expect(g.beforeSettle(OPTS)).toMatchObject({ kind: "critic" });
    g.criticDone(false);
    g.afterTool("write", bigWrite("logo.svg"), false);
    expect(g.beforeSettle(OPTS)).toBeNull();
    expect(g.exhausted(OPTS.maxRounds)).toBe(true);

    const other = setup().g;
    other.afterTool("write", bigWrite("logo.svg"), false);
    other.criticDone(true);
    other.afterTool("write", bigWrite("logo.svg"), false);
    expect(other.beforeSettle(OPTS)).toBeNull();
  });

  it("remembers the newest picture of the model's own work, not of references", () => {
    const { g } = setup();
    g.afterTool("mcp", { tool: "blender_get_viewport_screenshot" }, false, [{ type: "image", data: "MINE", mimeType: "image/png" }]);
    g.afterTool("look", { target: ".pi/design-refs/goblin/01-a.png" }, false, [{ type: "image", data: "REF", mimeType: "image/png" }]);
    g.afterTool("design_refs", { topic: "goblin" }, false, [{ type: "image", data: "SHEET", mimeType: "image/png" }]);
    expect(g.image?.data).toBe("MINE");
  });

  it("does nothing for runs without visual changes", () => {
    const { g } = setup();
    g.afterTool("write", bigWrite("main.py"), false);
    expect(g.beforeSettle(OPTS)).toBeNull();
  });
});
