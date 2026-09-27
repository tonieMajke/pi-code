import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FileChange, GitChanges, GpuInfo, RouterStatus } from "../../shared/protocol.js";
import { t } from "../../shared/i18n.js";

const run = promisify(execFile);
const PATCH_MAX = 60_000;

async function git(cwd: string, args: string[], timeout = 10_000): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout });
  return stdout;
}

/** git's own message (stderr) instead of "Command failed: git …". */
function gitError(err: unknown): Error {
  const e = err as { stderr?: string; message?: string };
  return new Error((e.stderr || e.message || String(err)).trim().split("\n").slice(-3).join("\n"));
}

async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

/** X = index, Y = worktree (porcelain v1). */
export function indexState(code: string): FileChange["index"] {
  const x = code[0];
  const y = code[1];
  if (x === " " || x === "?") return "none";
  return y === " " ? "staged" : "partial";
}

/** Working-tree changes vs HEAD (what the model changed, plus anything else uncommitted). */
export async function gitChanges(cwd: string): Promise<GitChanges> {
  let root: string;
  try {
    root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return { repo: false, root: "", files: [] };
  }
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const entries = status.split("\0").filter(Boolean);
  const files: FileChange[] = [];
  for (let i = 0; i < entries.length; i++) {
    const code = entries[i].slice(0, 2);
    const path = entries[i].slice(3);
    if (code[0] === "R" || code[0] === "C") i++; // rename: next entry is the source path
    let patch = "";
    let add = 0;
    let del = 0;
    try {
      if (code === "??") {
        patch = await git(root, ["diff", "--no-index", "--", "/dev/null", path]).catch((e: { stdout?: string }) => e.stdout ?? "");
      } else {
        // Before the first commit there is no HEAD: compare the index with nothing instead.
        patch = await git(root, ["diff", "HEAD", "--", path]).catch(() => git(root, ["diff", "--cached", "--", path]));
      }
    } catch {
      patch = "";
    }
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) add++;
      else if (line.startsWith("-") && !line.startsWith("---")) del++;
    }
    files.push({ path, status: code, add, del, patch: patch.length > PATCH_MAX ? `${patch.slice(0, PATCH_MAX)}\n…` : patch, index: indexState(code) });
  }
  return { repo: true, root, files };
}

/** Discard changes to one tracked file (restore from HEAD). Untracked files are refused. */
export async function gitRevert(cwd: string, path: string): Promise<void> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const st = (await git(root, ["status", "--porcelain=v1", "--", path])).slice(0, 2);
  if (st === "??") throw new Error(t("plik nieśledzony przez git — nie cofam (usuń go ręcznie)"));
  await git(root, ["restore", "--staged", "--worktree", "--source=HEAD", "--", path]);
}

/** `git add` (new, changed and deleted files alike). */
export async function gitStage(cwd: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const root = await repoRoot(cwd);
  await git(root, ["add", "--all", "--", ...paths]).catch((e) => {
    throw gitError(e);
  });
}

/** Take files out of the index; the worktree keeps the changes. */
export async function gitUnstage(cwd: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const root = await repoRoot(cwd);
  const hasHead = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).then(
    () => true,
    () => false,
  );
  // No HEAD yet (first commit): there is nothing to restore the index from.
  const args = hasHead ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "-r", "-q", "--", ...paths];
  await git(root, args).catch((e) => {
    throw gitError(e);
  });
}

/** Staged diff (what a commit would contain), for writing its message. */
export async function stagedDiff(cwd: string, max = 30_000): Promise<{ diff: string; recent: string[] }> {
  const root = await repoRoot(cwd);
  const diff = await git(root, ["diff", "--cached", "--stat", "--patch"]);
  const recent = await git(root, ["log", "-12", "--format=%s"]).then(
    (s) => s.split("\n").filter(Boolean),
    () => [],
  );
  return { diff: diff.length > max ? `${diff.slice(0, max)}\n… (${t("ucięte")})` : diff, recent };
}

/**
 * Commit what is staged. The author is whatever the project's git config says — the GUI
 * adds nothing. Hooks run (pre-commit may format or refuse), hence the long timeout.
 */
export async function gitCommit(cwd: string, message: string): Promise<{ commit: string; subject: string }> {
  const msg = message.trim();
  if (!msg) throw new Error(t("pusty opis commitu"));
  const root = await repoRoot(cwd);
  const staged = await git(root, ["diff", "--cached", "--name-only"]);
  if (!staged.trim()) throw new Error(t("nic nie jest dodane do commitu"));
  await git(root, ["commit", "-q", "-m", msg], 120_000).catch((e) => {
    throw gitError(e);
  });
  const [commit, subject] = (await git(root, ["log", "-1", "--format=%h%x00%s"])).trim().split("\0");
  return { commit, subject };
}

/** Project files for @-mentions: git-tracked + untracked-not-ignored, else a shallow walk. */
export async function listFiles(cwd: string): Promise<string[]> {
  try {
    const out = await git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard"]);
    return out.split("\n").filter(Boolean).slice(0, 20_000);
  } catch {
    const { stdout } = await run("find", [".", "-maxdepth", "4", "-type", "f", "-not", "-path", "*/.*", "-not", "-path", "*/node_modules/*"], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 5000,
    }).catch(() => ({ stdout: "" }));
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((p) => p.replace(/^\.\//, ""))
      .slice(0, 20_000);
  }
}

async function gpus(): Promise<GpuInfo[]> {
  try {
    const { stdout } = await run(
      "nvidia-smi",
      ["--query-gpu=index,name,memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"],
      { timeout: 3000 },
    );
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [index, name, used, total, util] = l.split(",").map((x) => x.trim());
        return { index: Number(index), name, memUsed: Number(used), memTotal: Number(total), util: Number(util) };
      });
  } catch {
    return [];
  }
}

/** llama-server router: which models are loaded/sleeping + GPU memory. */
export async function routerStatus(baseUrl: string | undefined): Promise<RouterStatus> {
  const models: RouterStatus["models"] = [];
  if (baseUrl) {
    try {
      const root = baseUrl.replace(/\/v1\/?$/, "");
      const res = await fetch(`${root}/v1/models`, { signal: AbortSignal.timeout(3000) });
      const json = (await res.json()) as { data?: { id: string; status?: { value?: string } }[] };
      for (const m of json.data ?? []) models.push({ id: m.id, status: m.status?.value ?? "unknown" });
    } catch {
      // router down or not a router — GPU info still useful
    }
  }
  return { models, gpus: await gpus() };
}

export async function notify(title: string, body: string): Promise<void> {
  await run("notify-send", ["--app-name=Pi", "--icon=dialog-information", title, body], { timeout: 3000 }).catch(() => undefined);
}
