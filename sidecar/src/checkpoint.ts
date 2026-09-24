import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Worktree snapshots so one click can undo everything a model run did to files.
 * A throwaway index captures tracked + untracked (non-ignored) files without
 * touching the user's index, stash or branches; a ref under refs/pi-gui keeps
 * the commit from being garbage-collected.
 */
async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await run("git", args, { cwd, env: { ...process.env, ...env }, maxBuffer: 32 * 1024 * 1024, timeout: 20000 });
  return stdout.trim();
}

async function worktreeTree(cwd: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-gui-idx-"));
  const index = join(dir, "index");
  const env = { GIT_INDEX_FILE: index };
  try {
    // Seed from the real index: its stat cache means only changed files get re-hashed
    // (an empty index would hash every file in the repo on every snapshot).
    const real = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    if (existsSync(real)) {
      copyFileSync(real, index);
      // Keep the original mtime: git re-hashes "racily clean" entries (file mtime >= index
      // mtime); a fresh mtime would hide same-size edits made in the same second.
      const st = statSync(real);
      utimesSync(index, st.atime, st.mtime);
    }
    else await git(cwd, ["read-tree", "--empty"], env);
    await git(cwd, ["add", "-A", "--", "."], env);
    return await git(cwd, ["write-tree"], env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

/** Snapshot the worktree; returns the commit id, or null outside git. */
export async function snapshot(cwd: string, label: string): Promise<string | null> {
  if (!(await isGitRepo(cwd))) return null;
  const tree = await worktreeTree(cwd);
  const commit = await git(cwd, ["commit-tree", tree, "-m", `pi-gui checkpoint: ${label}`], {
    GIT_AUTHOR_NAME: "pi-gui",
    GIT_AUTHOR_EMAIL: "pi-gui@localhost",
    GIT_COMMITTER_NAME: "pi-gui",
    GIT_COMMITTER_EMAIL: "pi-gui@localhost",
  });
  await git(cwd, ["update-ref", `refs/pi-gui/checkpoints/${commit}`, commit]);
  return commit;
}

export type CheckpointChange = { path: string; status: "A" | "M" | "D" };

/** Files that differ between the snapshot and the worktree now (paths relative to the repo root). */
export async function changesSince(cwd: string, commit: string): Promise<CheckpointChange[]> {
  const now = await worktreeTree(cwd);
  const out = await git(cwd, ["diff", "--name-status", "--no-renames", commit, now]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status: status[0] as CheckpointChange["status"], path: rest.join("\t") };
    });
}

/** Put every changed file back as it was at the snapshot; files created since are deleted. */
export async function restore(cwd: string, commit: string): Promise<CheckpointChange[]> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const changes = await changesSince(cwd, commit);
  const back = changes.filter((c) => c.status !== "A").map((c) => c.path);
  if (back.length) await git(root, ["restore", `--source=${commit}`, "--worktree", "--", ...back]);
  for (const c of changes.filter((c) => c.status === "A")) {
    try {
      unlinkSync(join(root, c.path));
    } catch {
      /* already gone */
    }
  }
  return changes;
}

/** Unified diff of everything changed since the snapshot (for the reviewer). */
export async function diffSince(cwd: string, commit: string): Promise<string> {
  const now = await worktreeTree(cwd);
  return git(cwd, ["diff", "--no-color", "--no-ext-diff", "-U3", commit, now]);
}
