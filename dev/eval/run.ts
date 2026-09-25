/**
 * Eval harness: runs real tasks through the sidecar against the local model and
 * checks them with hidden tests. Measure before believing a tweak helps.
 *
 *   pnpm eval                          # all tasks, profile "full"
 *   pnpm eval --profile base           # everything pi-gui adds switched off
 *   pnpm eval --only py-leap,js-async --repeat 3
 *   pnpm eval --only ui-bakery,ui-pricing --profile no-taste   # visual tasks: screenshot + ui_audit saved
 *   pnpm eval:taste <results-A.json> <results-B.json>           # pairwise judge of the screenshots
 *   pnpm eval --only bh-plan --model llama-server/Swift1.5-Qwen3.8-27B-Q6_K-2GPU
 *   pnpm eval --sidecar /path/to/old/checkout/sidecar/src/main.ts   # "before" of an A/B
 *
 * Behaviour tasks (bh-*) are checked from the run itself: the check script reads
 * .eval/transcript.json (texts, tool calls, approvals, mid-run messages, guards) in the task dir.
 * Every approval request is denied, like a user saying no.
 *
 * Profiles only change a temporary pi-gui.json (PI_GUI_CONFIG) — the user's config is untouched.
 */
import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { GuiConfig, PiEvent, SidecarOut } from "../../shared/protocol.js";
import { countBySeverity, uiAudit } from "../../sidecar/src/audit.js";
import { closeBrowser } from "../../sidecar/src/browser.js";
import { look } from "../../sidecar/src/look.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TASKS = join(ROOT, "dev/eval/tasks");
const RESULTS = join(ROOT, "dev/eval/results");

/** visual: a page the model must produce — screenshotted and measured after the run. */
type Task = {
  prompt: string;
  check: string;
  timeoutSec?: number;
  visual?: string;
  /** A real codebase instead of files/: this repo at a commit, a bug patched in, some tests taken away. */
  repo?: { commit: string; patch: string; remove?: string[] };
  /** A message the user sends while the model works, after this many tool calls. */
  midrun?: { afterToolCalls: number; text: string };
  /** A process the model did not start: spawned in the task dir, its PID in foreign.pid. */
  foreign?: string;
};
type Step =
  | { t: "text"; text: string }
  | { t: "tool"; name: string; args: unknown }
  | { t: "approval"; name: string; args: unknown }
  | { t: "user"; text: string }
  | { t: "guard"; label: string }
  /** End of an assistant message: its text came before, its tool calls come after. */
  | { t: "end" };
type Result = {
  task: string;
  pass: boolean;
  seconds: number;
  toolCalls: number;
  toolErrors: number;
  guards: string[];
  stuck: boolean;
  inputTokens: number;
  outputTokens: number;
  checkOutput: string;
  error?: string;
  /** Visual tasks: ui_audit counts and the screenshot for pairwise judging. */
  audit?: { high: number; medium: number; low: number };
  shot?: string;
  /** Where the model left its files (visual tasks: kept for inspection). */
  dir?: string;
  /** From the run's own stats log: time reading the prompt vs generating (main model). */
  promptSeconds?: number;
  genSeconds?: number;
  approvals?: number;
};

const PROFILES: Record<string, Partial<GuiConfig>> = {
  full: {},
  base: {
    constitution: { enabled: false, hard: false, text: "", maxNudges: 0 },
    review: { enabled: false, model: "", minLines: 0 },
    sampling: { enabled: false, temperature: null, top_p: null, top_k: null, min_p: null, presence_penalty: null, repeat_penalty: null, reasoning_budget_tokens: null },
    context: { elideOldToolOutput: false, elideAboveChars: 2000 },
    taste: { enabled: false, research: "off", critic: false, criticModel: "", maxRounds: 3, requireAudit: false, criticSlot: null },
    // every tool always loaded, like plain pi
    tools: Object.fromEntries(["*"].map((k) => [k, "always" as const])),
  },
  "no-review": { review: { enabled: false, model: "", minLines: 0 } },
  "no-editfix": {},
  "no-think-limit": { sampling: { enabled: false, temperature: null, top_p: null, top_k: null, min_p: null, presence_penalty: null, repeat_penalty: null, reasoning_budget_tokens: null } },
  "no-taste": { taste: { enabled: false, research: "off", critic: false, criticModel: "", maxRounds: 3, requireAudit: false, criticSlot: null } },
};

/** Switches that live in the environment, not the config (eval-only A/B knobs). */
const PROFILE_ENV: Record<string, Record<string, string>> = {
  "no-editfix": { PI_GUI_NO_EDITFIX: "1" },
};

/** One folder per eval run: the JSON plus screenshots of visual tasks. */
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

function args() {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    profile: get("profile") ?? "full",
    only: get("only")?.split(",") ?? null,
    repeat: Number(get("repeat") ?? 1),
    /** "provider/id"; default = pi's default model. */
    model: get("model") ?? null,
    sidecar: get("sidecar") ?? join(ROOT, "sidecar/src/main.ts"),
  };
}

/** "*" in the base profile means: every tool "always" — expanded once the sidecar reports the tool list. */
function configFile(profile: string, toolNames: string[]): string {
  const p = structuredClone(PROFILES[profile] ?? {});
  if (p.tools && "*" in p.tools) p.tools = Object.fromEntries(toolNames.map((n) => [n, "always" as const]));
  const dir = mkdtempSync(join(tmpdir(), "pi-gui-eval-cfg-"));
  const file = join(dir, "pi-gui.json");
  writeFileSync(file, JSON.stringify(p, null, 2));
  return file;
}

function prepare(task: string, spec: Task): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-gui-eval-${task}-`));
  if (spec.repo) {
    execFileSync("sh", ["-c", `git -C "$0" archive "$1" | tar -x -C "$2"`, ROOT, spec.repo.commit, dir]);
    execFileSync("git", ["apply", join(TASKS, task, spec.repo.patch)], { cwd: dir });
    for (const f of spec.repo.remove ?? []) rmSync(join(dir, f), { force: true });
    rmSync(join(dir, "dev/eval"), { recursive: true, force: true }); // no answers lying around
    // the live-model e2e would wait minutes on a bridge port (and on the model) mid-task
    rmSync(join(dir, "dev/e2e-smoke.test.ts"), { force: true });
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  } else cpSync(join(TASKS, task, "files"), dir, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=e@e", "-c", "user.name=eval", "add", "-A");
  git("-c", "user.email=e@e", "-c", "user.name=eval", "commit", "-qm", "start");
  return dir;
}

/** npx → tsx → node: killing only npx orphans the sidecar, so kill the whole group. */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

/** One sidecar process per task: clean session state, no cross-talk. */
type RunOpts = { model: string | null; sidecar: string };

async function runTask(task: string, spec: Task, cfgFile: string, runDir: string, n: number, extraEnv: Record<string, string>, opts: RunOpts): Promise<Result> {
  const cwd = prepare(task, spec);
  const foreign = spec.foreign ? spawn("sh", ["-c", spec.foreign], { cwd, stdio: "ignore", detached: true }) : null;
  if (foreign?.pid) writeFileSync(join(cwd, "foreign.pid"), `${foreign.pid}\n`);
  const statsFile = join(runDir, `${task}-${n}-stats.jsonl`);
  const child = spawn("npx", ["tsx", opts.sidecar], {
    cwd: dirname(dirname(dirname(opts.sidecar))),
    env: { ...process.env, ...extraEnv, PI_GUI_CONFIG: cfgFile, PI_GUI_EPHEMERAL: "1", PI_GUI_STATS: statsFile },
    stdio: ["pipe", "pipe", "ignore"],
    detached: true,
  });
  let id = 0;
  const send = (c: object) => child.stdin.write(`${JSON.stringify({ id: ++id, ...c })}\n`);
  const r: Result = {
    task,
    pass: false,
    seconds: 0,
    toolCalls: 0,
    toolErrors: 0,
    guards: [],
    stuck: false,
    inputTokens: 0,
    outputTokens: 0,
    checkOutput: "",
    approvals: 0,
  };
  const steps: Step[] = [];
  let text = "";
  const flush = () => {
    if (text.trim()) steps.push({ t: "text", text });
    text = "";
  };
  let midrunSent = false;
  const t0 = Date.now();
  const timeout = (spec.timeoutSec ?? 420) * 1000;
  try {
    await new Promise<void>((resolveRun, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), timeout);
      let prompted = false;
      createInterface({ input: child.stdout }).on("line", (line) => {
        let msg: SidecarOut;
        try {
          msg = JSON.parse(line) as SidecarOut;
        } catch {
          return;
        }
        if ("event" in msg) {
          const e: PiEvent = msg.event;
          if (e.kind === "text_delta") text += e.delta;
          else if (e.kind === "message_end") {
            flush();
            steps.push({ t: "end" });
          }
          else if (e.kind === "tool_start") {
            flush();
            r.toolCalls++;
            steps.push({ t: "tool", name: e.toolName, args: e.args });
            if (spec.midrun && !midrunSent && r.toolCalls >= spec.midrun.afterToolCalls) {
              midrunSent = true;
              steps.push({ t: "user", text: spec.midrun.text });
              send({ cmd: "prompt", text: spec.midrun.text, behavior: "steer" });
            }
          } else if (e.kind === "approval_request") {
            r.approvals = (r.approvals ?? 0) + 1;
            steps.push({ t: "approval", name: e.toolName, args: e.args });
            send({ cmd: "approve", toolCallId: e.toolCallId, decision: "deny" });
          } else if (e.kind === "tool_end" && e.result.isError) r.toolErrors++;
          else if (e.kind === "guard") {
            r.guards.push(e.label);
            steps.push({ t: "guard", label: e.label });
          }
          else if (e.kind === "stuck") r.stuck = true;
          else if (e.kind === "usage") {
            r.inputTokens = e.usage.inputTokens;
            r.outputTokens = e.usage.outputTokens;
          } else if (e.kind === "settled" && prompted) {
            clearTimeout(timer);
            resolveRun();
          }
          return;
        }
        if (!msg.ok) {
          clearTimeout(timer);
          reject(new Error(`${msg.cmd}: ${msg.error}`));
          return;
        }
        const go = () => {
          prompted = true;
          send({ cmd: "mode_set", mode: "yolo" });
          send({ cmd: "prompt", text: spec.prompt });
        };
        if (msg.cmd === "init" && !prompted) {
          if (!opts.model) go();
          else {
            const [provider, ...rest] = opts.model.split("/");
            send({ cmd: "model_set", provider, modelId: rest.join("/") });
          }
        }
        if (msg.cmd === "model_set" && !prompted) go();
      });
      child.on("exit", () => reject(new Error("sidecar exited")));
      send({ cmd: "init", cwd });
    });
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err);
  } finally {
    r.seconds = Math.round((Date.now() - t0) / 1000);
    child.stdin.end();
    killTree(child.pid);
  }
  flush();
  mkdirSync(join(cwd, ".eval"), { recursive: true });
  writeFileSync(join(cwd, ".eval/transcript.json"), JSON.stringify(steps, null, 2));
  try {
    const rows = readFileSync(statsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { role: string; promptMs: number; genMs: number });
    const main = rows.filter((x) => x.role === "main");
    r.promptSeconds = Math.round(main.reduce((a, x) => a + (x.promptMs ?? 0), 0) / 1000);
    r.genSeconds = Math.round(main.reduce((a, x) => a + (x.genMs ?? 0), 0) / 1000);
  } catch {
    /* no local requests */
  }
  // Hidden tests arrive only now — the model could not tailor code (or tests) to them.
  const hidden = join(TASKS, task, "hidden");
  if (existsSync(hidden)) cpSync(hidden, cwd, { recursive: true });
  try {
    r.checkOutput = execFileSync("bash", ["-c", spec.check], { cwd, encoding: "utf8", timeout: 60000, stdio: "pipe" }).slice(-400);
    r.pass = true;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    r.checkOutput = `${e.stdout ?? ""}${e.stderr ?? ""}`.slice(-600);
  }
  if (foreign?.pid) killTree(foreign.pid);
  if (spec.visual && existsSync(join(cwd, spec.visual))) {
    r.dir = cwd;
    try {
      r.audit = countBySeverity((await uiAudit({ target: spec.visual }, cwd)).issues);
      const shot = await look({ target: spec.visual, width: 1280, height: 900 }, cwd);
      r.shot = join(runDir, `${task}-${n}.png`);
      writeFileSync(r.shot, Buffer.from(shot.data, "base64"));
    } catch (err) {
      r.checkOutput += `\n[visual] ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return r;
}

/** Tool names, for expanding the base profile's "*". */
async function toolNames(): Promise<string[]> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-gui-eval-probe-"));
  const child = spawn("npx", ["tsx", join(ROOT, "sidecar/src/main.ts")], {
    cwd: ROOT,
    env: { ...process.env, PI_GUI_EPHEMERAL: "1" },
    stdio: ["pipe", "pipe", "ignore"],
    detached: true,
  });
  const send = (c: object) => child.stdin.write(`${JSON.stringify(c)}\n`);
  try {
    return await new Promise<string[]>((res, rej) => {
      createInterface({ input: child.stdout }).on("line", (line) => {
        const msg = JSON.parse(line) as SidecarOut;
        if ("event" in msg) return;
        if (msg.cmd === "init") send({ id: 2, cmd: "settings_get" });
        if (msg.cmd === "settings_get" && msg.ok) res((msg.result as { tools: { name: string }[] }).tools.map((t) => t.name));
        if (!msg.ok) rej(new Error(msg.error));
      });
      send({ id: 1, cmd: "init", cwd });
    });
  } finally {
    killTree(child.pid);
  }
}

async function main() {
  const { profile, only, repeat, model, sidecar } = args();
  if (!(profile in PROFILES)) throw new Error(`unknown profile ${profile}; known: ${Object.keys(PROFILES).join(", ")}`);
  const tasks = readdirSync(TASKS).filter((t) => !only || only.includes(t)).sort();
  const cfg = configFile(profile, profile === "base" ? await toolNames() : []);
  console.log(`profile ${profile} · ${tasks.length} tasks × ${repeat}\n`);
  const results: Result[] = [];
  const runDir = join(RESULTS, `${STAMP}-${profile}`);
  mkdirSync(runDir, { recursive: true });
  for (let i = 0; i < repeat; i++) {
    for (const task of tasks) {
      const spec = JSON.parse(readFileSync(join(TASKS, task, "task.json"), "utf8")) as Task;
      const r = await runTask(task, spec, cfg, runDir, i, PROFILE_ENV[profile] ?? {}, { model, sidecar });
      results.push(r);
      console.log(
        `${r.pass ? "PASS" : "FAIL"}  ${task.padEnd(16)} ${String(r.seconds).padStart(4)}s  tools ${String(r.toolCalls).padStart(2)} (err ${r.toolErrors})` +
          `  guards ${r.guards.length}${r.stuck ? " STUCK" : ""}${r.error ? `  [${r.error}]` : ""}` +
          (r.promptSeconds !== undefined ? `  prompt ${r.promptSeconds}s gen ${r.genSeconds}s` : "") +
          (r.approvals ? `  asked ${r.approvals}×` : "") +
          (r.audit ? `  audit ${r.audit.high}/${r.audit.medium}/${r.audit.low}` : ""),
      );
      if (!r.pass) console.log(`      ${r.checkOutput.trim().split("\n").slice(-3).join("\n      ")}`);
    }
  }
  const passed = results.filter((r) => r.pass).length;
  const secs = results.reduce((a, r) => a + r.seconds, 0);
  console.log(`\n${profile}: ${passed}/${results.length} passed · ${Math.round(secs / 60)} min total`);
  const out = join(runDir, "results.json");
  writeFileSync(out, JSON.stringify({ profile, repeat, passed, total: results.length, results }, null, 2));
  console.log(`results: ${out}`);
  await closeBrowser();
  process.exit(0);
}

void main();
