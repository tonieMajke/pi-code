import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changesSince, restore, snapshot } from "./checkpoint.js";
import { elideOldToolOutput } from "./elide.js";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "pi-gui-cp-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, "gone.txt"), "keep me\n");
  g("add", ".");
  g("commit", "-qm", "init");
  writeFileSync(join(dir, "draft.txt"), "untracked before\n");
  return { dir, g };
}

describe("checkpoint", () => {
  it("restores modified, deleted and untracked files and removes new ones", async () => {
    const { dir, g } = repo();
    const indexBefore = g("diff", "--cached", "--name-only");
    const cp = await snapshot(dir, "test");
    expect(cp).toMatch(/^[0-9a-f]{40}$/);

    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "draft.txt"), "changed\n");
    writeFileSync(join(dir, "new.txt"), "new\n");
    execFileSync("rm", [join(dir, "gone.txt")]);

    const changes = await changesSince(dir, cp!);
    expect(changes.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { status: "M", path: "a.txt" },
      { status: "M", path: "draft.txt" },
      { status: "D", path: "gone.txt" },
      { status: "A", path: "new.txt" },
    ]);

    await restore(dir, cp!);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(dir, "draft.txt"), "utf8")).toBe("untracked before\n");
    expect(readFileSync(join(dir, "gone.txt"), "utf8")).toBe("keep me\n");
    expect(existsSync(join(dir, "new.txt"))).toBe(false);
    expect(await changesSince(dir, cp!)).toEqual([]);
    // the user's index and stash are untouched
    expect(g("diff", "--cached", "--name-only")).toBe(indexBefore);
    expect(g("stash", "list")).toBe("");
  });

  it("returns null outside git", async () => {
    expect(await snapshot(mkdtempSync(join(tmpdir(), "pi-gui-nogit-")), "x")).toBeNull();
  });
});

describe("elideOldToolOutput", () => {
  const big = "x".repeat(5000);
  const tool = (text: string) => ({ role: "toolResult", content: [{ type: "text", text }] });
  it("shortens big results before the last user message only", () => {
    const msgs = [{ role: "user", content: "a" }, tool(big), tool("small"), { role: "user", content: "b" }, tool(big)];
    const out = elideOldToolOutput(msgs, 2000);
    expect((out[1].content as { text: string }[])[0].text).toMatch(/shortened \(5000 chars\)/);
    expect(out[2]).toBe(msgs[2]);
    expect(out[4]).toBe(msgs[4]);
  });
  it("returns the same array when nothing changes", () => {
    const msgs = [{ role: "user", content: "a" }, tool("small")];
    expect(elideOldToolOutput(msgs, 2000)).toBe(msgs);
  });
});
