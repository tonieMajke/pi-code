import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitChanges, gitCommit, gitStage, gitUnstage, indexState, stagedDiff } from "./workspace";

let repo = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "pi-gui-ws-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test Author");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const byPath = async () => Object.fromEntries((await gitChanges(repo)).files.map((f) => [f.path, f.index]));

describe("index state", () => {
  it("reads porcelain XY", () => {
    expect(indexState("??")).toBe("none");
    expect(indexState(" M")).toBe("none");
    expect(indexState("M ")).toBe("staged");
    expect(indexState("MM")).toBe("partial");
    expect(indexState("A ")).toBe("staged");
  });
});

describe("stage, unstage, commit", () => {
  it("works before the first commit (no HEAD) and after it", async () => {
    writeFileSync(join(repo, "a.txt"), "a\n");
    writeFileSync(join(repo, "b.txt"), "b\n");
    expect(await byPath()).toEqual({ "a.txt": "none", "b.txt": "none" });

    await gitStage(repo, ["a.txt", "b.txt"]);
    expect(await byPath()).toEqual({ "a.txt": "staged", "b.txt": "staged" });
    await gitUnstage(repo, ["b.txt"]); // no HEAD yet → rm --cached
    expect(await byPath()).toEqual({ "a.txt": "staged", "b.txt": "none" });

    const first = await gitCommit(repo, "first: a only\n\nbody");
    expect(first.subject).toBe("first: a only");
    expect(git("log", "--format=%an <%ae>").trim()).toBe("Test Author <test@example.com>"); // from git config, nothing invented
    expect(await byPath()).toEqual({ "b.txt": "none" });

    writeFileSync(join(repo, "a.txt"), "a2\n");
    await gitStage(repo, ["a.txt"]);
    writeFileSync(join(repo, "a.txt"), "a3\n"); // more edits after git add
    expect((await byPath())["a.txt"]).toBe("partial");
    await gitUnstage(repo, ["a.txt"]); // HEAD exists → restore --staged, worktree keeps a3
    expect((await byPath())["a.txt"]).toBe("none");
    expect(git("show", ":a.txt")).toBe("a\n");
  });

  it("stages a deletion; refuses an empty message or an empty index", async () => {
    writeFileSync(join(repo, "a.txt"), "a\n");
    await gitStage(repo, ["a.txt"]);
    await gitCommit(repo, "init");
    await expect(gitCommit(repo, "nothing")).rejects.toThrow(/nic nie jest dodane/);
    rmSync(join(repo, "a.txt"));
    await gitStage(repo, ["a.txt"]);
    expect((await gitChanges(repo)).files).toMatchObject([{ path: "a.txt", status: "D ", index: "staged" }]);
    await expect(gitCommit(repo, "   ")).rejects.toThrow(/pusty opis/);
    const { diff, recent } = await stagedDiff(repo);
    expect(diff).toContain("-a");
    expect(recent).toEqual(["init"]);
  });

  it("reports git's own error (hook refused)", async () => {
    writeFileSync(join(repo, "a.txt"), "a\n");
    await gitStage(repo, ["a.txt"]);
    writeFileSync(join(repo, ".git/hooks/pre-commit"), "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n", { mode: 0o755 });
    await expect(gitCommit(repo, "x")).rejects.toThrow(/lint failed/);
  });
});
