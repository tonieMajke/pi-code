import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * The "constitution": standing rules for the model (appended to the system prompt)
 * plus hard guards that enforce the parts small models skip — read before edit,
 * don't loop on a failing call, verify before handing the turn back.
 */
export const DEFAULT_CONSTITUTION = `# Operating constitution (non-negotiable)

You are a careful engineer working in a real repository. These rules override your habits.

## 1. Understand before acting
- Restate the goal to yourself in one sentence. If the request is ambiguous in a way that changes what you would build, ask one precise question instead of guessing.
- Read before you write: open every file you are about to change (at least the relevant part) in this session. Never edit from memory or assumption.
- Look for existing patterns (similar functions, tests, config) and follow them. To find your way around, use project_report / symbol_search (or grep/find) instead of guessing paths.
- Visual work (UI, CSS, SVG, diagrams, 3D models): load the matching skill first (ui-design, svg-diagrams, 3d-models), collect references with design_refs before the first change, and look at the rendered result after every change (the look tool, or the editor's screenshot tool). For pages, ui_audit must be clean before you finish.
- Some tools are loaded on demand. If the task needs one that is listed as available but not loaded, call enable_tools first.

## 2. Plan small
- For anything beyond a one-line change, write a short plan (3-7 steps) with the todo tool before the first edit. Keep one item in_progress and update the list as you go; it is shown to you at the end of the context.
- One logical change at a time. Do not rewrite code that works and is out of scope.

## 3. The loop: change -> verify -> fix
After EVERY meaningful change:
1. Verify it with the strongest check available: run the tests, the type checker or compiler, the linter, or run the program and read its output.
2. Read the output completely. A command that errored is a failed check, even if the error looks unrelated.
3. If it fails: find the cause, fix it, verify again. Never move on with a failing check.
Never claim something works unless you ran something that proved it. If no check is possible, say so and state what you checked instead (for example: re-read the diff).

When fixing a bug: first reproduce it (a failing test or a command that shows the wrong behaviour), then fix, then show the same check passing. When adding behaviour that has tests nearby, add or extend a test for it.

## 4. Don't get lost
- If the same approach failed twice, stop. Re-read the error and the code, state a new hypothesis, then try something different. Never repeat an identical command expecting a different result.
- Keep a list of the files you changed. Before finishing, re-read your changes.
- Stay inside the project. Do not touch files unrelated to the task.

## 5. Be honest
- Finish with: what you changed, how you verified it (the exact command and result), and anything left undone or uncertain. No "should work".
- Do not invent APIs, file paths, flags or outputs. If unsure, look it up in the code or run --help.
- Destructive actions (deleting, overwriting, force-pushing, installing) need a stated reason.

Reply in the user's language.`;

export const CONSTITUTION_MESSAGE_TYPE = "pi-gui-constitution";

/** Commands that count as checking work: tests, type checks, builds, running the program. */
const CHECK = new RegExp(
  [
    String.raw`\b(test|tests|pytest|vitest|jest|mocha|ava|tap|phpunit|rspec)\b`,
    String.raw`\b(tsc|typecheck|type-check|lint|eslint|biome|ruff|mypy|pyright|flake8|pylint|shellcheck|clippy)\b`,
    String.raw`\bcargo\s+(test|check|build|run|clippy)\b`,
    String.raw`\bgo\s+(test|build|vet|run)\b`,
    String.raw`\b(make|cmake|ninja|meson|gradle|gradlew|mvn|bazel)\b`,
    String.raw`\bdotnet\s+(build|test|run)\b`,
    String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+\S+|test|build|check|typecheck|lint|exec)\b`,
    String.raw`\b(npx|pnpx|bunx|uvx)\s+\S`,
    String.raw`\b(node|deno|bun|tsx|ts-node|python3?|ruby|php|perl|java|lua)\s+\S`,
    String.raw`\b(gcc|g\+\+|clang|clang\+\+|rustc|javac|zig|nim)\b`,
    String.raw`(^|[\s;&|])(\./|bash\s+|sh\s+)\S+`,
    String.raw`\b(py_compile|compileall|godot)\b`,
    String.raw`\bgit\s+diff\b`, // re-reading the diff is the fallback check the rules allow
  ].join("|"),
  "i",
);

export function isCheckCommand(command: string): boolean {
  return CHECK.test(command);
}

/** Edits to prose don't need a test run. */
const DOC_FILE = /\.(md|mdx|txt|rst|adoc)$/i;

/** Files whose correctness is mostly how they look. (tsx/jsx left out: usually logic.) */
export const VISUAL_FILE = /\.(html?|css|scss|sass|less|svg|dot|gv|mmd|mermaid|vue|svelte)$/i;

/** MCP calls into 3D editors that change the scene (reads and screenshots don't). */
export function isSceneChange(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName !== "mcp" || typeof input.tool !== "string") return false;
  const m = /^(blender|blockbench)[_-](.+)$/i.exec(input.tool);
  if (!m) return false;
  return !/^(get|list|search|describe|read|find|capture|screenshot|render|export|preview|status|help)/i.test(m[2]) &&
    !/screenshot|capture/i.test(m[2]);
}

type Nudge = { content: string; label: string };

/**
 * "Enough, wrap it up" from the user — Polish or English. Guards stop sending the model
 * back to work for the rest of that run: the user has seen the state and decided.
 */
const WORD_END = "(?![a-ząćęłńóśźż])";
const FINISH = new RegExp(
  [
    `\\b(s|za)?ko[nń]cz${WORD_END}`, // kończ / skończ / zakończ — not "zakończenie"
    "\\bwystarczy\\s*([.!,]|$)",
    "\\bzostaw\\s+(to|tak)\\b",
    "\\b(that'?s\\s+)?enough\\s*([.!,]|$)",
    "\\bwrap\\s+(it\\s+)?up\\b",
    "\\bgood\\s+enough\\b",
    "\\bship\\s+it\\b",
  ].join("|"),
  "i",
);

export function finishIntent(text: string): boolean {
  return FINISH.test(text);
}

/**
 * Per-session guard state. Tool hooks feed it; beforeSettle decides whether the
 * model must keep going. All paths are absolute.
 */
export class ConstitutionGuard {
  /** Files the model has seen (read) or produced (edit/write) this session. */
  private known = new Set<string>();
  // Per run (reset on every user prompt):
  private edited: string[] = [];
  private editSeq = 0;
  private checkSeq = 0;
  private seq = 0;
  private lastCheck: { command: string; failed: boolean } | null = null;
  /** Last visual change (file or 3D scene) vs last time the model saw an image. */
  private visualSeq = 0;
  private sawSeq = 0;
  private visualWhat: string[] = [];
  private nudges = 0;
  private loopBlocks = 0;
  /** Consecutive failures per identical call (tool + args). */
  private failures = new Map<string, number>();
  /** The user said "finish" this run: no more nudges. */
  private userDone = false;

  constructor(private readonly cwd: () => string) {}

  private abs(p: unknown): string | null {
    if (typeof p !== "string" || !p) return null;
    const clean = p.startsWith("@") ? p.slice(1) : p;
    return isAbsolute(clean) ? resolve(clean) : resolve(this.cwd(), clean);
  }

  /** Files changed in this run (absolute). */
  get changedFiles(): string[] {
    return this.edited;
  }

  /** The user asked to wrap up (see finishIntent): stop nudging and reviewing this run. */
  userFinish(): void {
    this.userDone = true;
  }

  get finishedByUser(): boolean {
    return this.userDone;
  }

  startRun(): void {
    this.userDone = false;
    this.edited = [];
    this.editSeq = 0;
    this.checkSeq = 0;
    this.seq = 0;
    this.lastCheck = null;
    this.visualSeq = 0;
    this.sawSeq = 0;
    this.visualWhat = [];
    this.nudges = 0;
    this.loopBlocks = 0;
    this.failures.clear();
  }

  /** tool_call: return a block reason, or null to let it run. */
  beforeTool(toolName: string, input: Record<string, unknown>): string | null {
    const sig = `${toolName} ${JSON.stringify(input)}`;
    if ((this.failures.get(sig) ?? 0) >= 2) {
      this.loopBlocks++;
      return (
        "Constitution: you already ran this exact call twice and it failed both times. " +
        "Do not repeat it. Re-read the error, state a new hypothesis, and try a different approach."
      );
    }
    if (toolName === "edit" || toolName === "write") {
      const path = this.abs(input.path ?? input.file_path);
      if (path && existsSync(path) && !this.known.has(path)) {
        return (
          `Constitution: read ${input.path as string} before ${toolName === "edit" ? "editing" : "overwriting"} it. ` +
          "Use the read tool on the file (at least the part you will change), then retry. Edits made from memory are how small mistakes happen."
        );
      }
    }
    return null;
  }

  /** tool_result: record what happened. */
  afterTool(toolName: string, input: Record<string, unknown>, isError: boolean, hasImage = false): void {
    this.seq++;
    if (hasImage && !isError) this.sawSeq = this.seq;
    if (!isError && isSceneChange(toolName, input)) {
      this.visualSeq = this.seq;
      const what = String(input.tool).startsWith("blender") ? "the Blender scene" : "the Blockbench model";
      if (!this.visualWhat.includes(what)) this.visualWhat.push(what);
    }
    const sig = `${toolName} ${JSON.stringify(input)}`;
    this.failures.set(sig, isError ? (this.failures.get(sig) ?? 0) + 1 : 0);

    const path = this.abs(input.path ?? input.file_path);
    if (toolName === "read" && path && !isError) this.known.add(path);
    if ((toolName === "edit" || toolName === "write") && path && !isError) {
      this.known.add(path);
      if (!this.edited.includes(path)) this.edited.push(path);
      if (!DOC_FILE.test(path)) this.editSeq = this.seq;
      if (VISUAL_FILE.test(path)) {
        this.visualSeq = this.seq;
        const rel = path.startsWith(`${this.cwd()}/`) ? path.slice(this.cwd().length + 1) : path;
        if (!this.visualWhat.includes(rel)) this.visualWhat.push(rel);
      }
    }
    // A failing `git diff` (e.g. not a repo) says nothing about the code — only a clean one counts.
    const diffOnly = typeof input.command === "string" && /^\s*git\s+diff\b/.test(input.command);
    if (toolName === "bash" && typeof input.command === "string" && isCheckCommand(input.command) && !(diffOnly && isError)) {
      this.checkSeq = this.seq;
      this.lastCheck = { command: input.command, failed: isError };
    }
  }

  /** agent_before_settle: a message that sends the model back to work, or null. */
  beforeSettle(maxNudges: number): Nudge | { stuck: string } | null {
    if (this.userDone) return null;
    const rel = (p: string) => (p.startsWith(`${this.cwd()}/`) ? p.slice(this.cwd().length + 1) : p);
    let nudge: Nudge | null = null;
    // For purely visual files, looking at the render after the last change is the check.
    const codeFiles = this.edited.filter((p) => !DOC_FILE.test(p));
    const lookedIsEnough = codeFiles.length > 0 && codeFiles.every((p) => VISUAL_FILE.test(p)) && this.sawSeq >= this.editSeq;
    if (this.editSeq > 0 && this.checkSeq < this.editSeq && !lookedIsEnough) {
      const files = this.edited.filter((p) => !DOC_FILE.test(p)).map(rel);
      nudge = {
        label: `Wymuszona weryfikacja: zmieniono ${files.length} plik(i) bez sprawdzenia`,
        content:
          `[Constitution: verification required]\nYou changed ${files.join(", ")} but ran no check after the last change. ` +
          "Before you finish: run the most relevant check (tests, type check, build, or run the program), read the whole output, and fix any failure. " +
          "If no automated check exists for this change, run `git diff` (or re-read the changed regions), then say explicitly that no automated check was possible.",
      };
    } else if (this.lastCheck?.failed && this.checkSeq >= this.editSeq) {
      nudge = {
        label: "Wymuszona poprawka: ostatnie sprawdzenie nie przeszło",
        content:
          `[Constitution: failing check]\nThe last check failed and nothing was changed after it:\n  ${this.lastCheck.command}\n` +
          "Fix the cause and run the check again. If it cannot be fixed now, say so explicitly and explain why — do not report the task as done.",
      };
    }
    if (!nudge && this.visualSeq > this.sawSeq) {
      nudge = {
        label: "Wymuszony podgląd: zmiana wizualna bez obejrzenia wyniku",
        content:
          `[Constitution: look at your work]\nYou changed ${this.visualWhat.join(", ")} but have not looked at the result since. ` +
          "Render it and look: use the look tool (page URL or .html/.svg/.dot/.mmd file), or the Blender/Blockbench MCP screenshot tool for 3D. " +
          "Check layout, alignment, spacing, contrast, overlaps and whether it matches the request; fix what is off, then look again.",
      };
    }
    if (!nudge) return this.loopBlocks >= 2 ? { stuck: "Model w kółko powtarza nieudane wywołania" } : null;
    if (this.nudges >= maxNudges) return { stuck: nudge.label };
    this.nudges++;
    return nudge;
  }
}
