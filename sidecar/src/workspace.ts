import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FileChange, GitChanges, GpuInfo, RouterStatus } from "../../shared/protocol.js";

const run = promisify(execFile);
const PATCH_MAX = 60_000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 10_000 });
  return stdout;
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
        patch = await git(root, ["diff", "HEAD", "--", path]);
      }
    } catch {
      patch = "";
    }
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) add++;
      else if (line.startsWith("-") && !line.startsWith("---")) del++;
    }
    files.push({ path, status: code, add, del, patch: patch.length > PATCH_MAX ? `${patch.slice(0, PATCH_MAX)}\n…` : patch });
  }
  return { repo: true, root, files };
}

/** Discard changes to one tracked file (restore from HEAD). Untracked files are refused. */
export async function gitRevert(cwd: string, path: string): Promise<void> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const st = (await git(root, ["status", "--porcelain=v1", "--", path])).slice(0, 2);
  if (st === "??") throw new Error("plik nieśledzony przez git — nie cofam (usuń go ręcznie)");
  await git(root, ["restore", "--staged", "--worktree", "--source=HEAD", "--", path]);
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
