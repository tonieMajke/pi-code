import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProgressWatch } from "./progress.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pi-gui-progress-"));
  writeFileSync(join(dir, "a.py"), "x = 1\n");
  const w = new ProgressWatch(() => dir);
  w.startRun();
  const edit = (content: string) => {
    w.beforeTool("edit", { path: "a.py" });
    writeFileSync(join(dir, "a.py"), content);
    return w.afterTool("edit", { path: "a.py" }, false, "");
  };
  return { w, edit };
}

describe("ProgressWatch", () => {
  it("notices a file edited back to an earlier state", () => {
    const { edit } = setup();
    expect(edit("x = 2\n")).toBeNull();
    expect(edit("x = 3\n")).toBeNull();
    expect(edit("x = 1\n")).toMatch(/exactly as it was 3 change\(s\) ago/);
  });

  it("notices the same failure three times with edits in between, ignoring timings", () => {
    const { w, edit } = setup();
    const fail = (ms: number) => w.afterTool("bash", { command: "pytest -q" }, true, `FAILED test_a - assert 1 == 2\n1 failed in ${ms}ms`);
    expect(fail(10)).toBeNull();
    edit("x = 2\n");
    expect(fail(12)).toBeNull();
    expect(fail(13)).toBeNull(); // no edit in between: rerunning is not a loop
    edit("x = 3\n");
    expect(fail(15)).toMatch(/failed the same way 3 times/);
    expect(w.afterTool("bash", { command: "pytest -q" }, false, "1 passed")).toBeNull();
  });
});
