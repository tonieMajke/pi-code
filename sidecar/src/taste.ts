import { isAbsolute, resolve } from "node:path";
import { isSceneChange, VISUAL_FILE } from "./constitution.js";

/**
 * The taste guard: the loop small models skip on their own.
 *   references first → build → ui_audit clean → fresh-eyes critic OK (or rounds used up).
 * Pure state; the gateway runs the tools and the critic and feeds results back.
 */

/** Pages (as opposed to SVG/diagrams/3D): these get ui_audit. */
const PAGE_FILE = /\.(html?|css|scss|sass|less|vue|svelte|[jt]sx)$/i;
/** JSX/TSX edits count as visual only when they touch markup or styling. */
const MARKUP = /className=|style=\{|<(div|section|header|main|nav|footer|button|span|ul|li|h[1-6]|p|img|form|input|label|aside|article)\b/;
/** An edit this small to an existing file is a tweak, not new visual work — no research needed. */
const SMALL_EDIT_LINES = 10;

export type VisualKind = "ui" | "image";
export type TasteNudge = { content: string; label: string };
export type SettleStep =
  | { kind: "nudge"; nudge: TasteNudge }
  | { kind: "critic"; visual: VisualKind; target: string | null }
  | null;

function editText(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "write") return typeof input.content === "string" ? input.content : "";
  const edits = Array.isArray(input.edits) ? (input.edits as { newText?: unknown }[]) : [];
  const single = typeof input.newText === "string" ? input.newText : typeof input.new_string === "string" ? input.new_string : "";
  return [single, ...edits.map((e) => (typeof e.newText === "string" ? e.newText : ""))].join("\n");
}

/** Does this tool call change something whose quality is how it looks? */
export function visualChange(toolName: string, input: Record<string, unknown>): VisualKind | null {
  if (isSceneChange(toolName, input)) return "image";
  if (toolName !== "edit" && toolName !== "write") return null;
  const path = String(input.path ?? input.file_path ?? "");
  if (/\.[jt]sx$/i.test(path)) return MARKUP.test(editText(toolName, input)) ? "ui" : null;
  if (!VISUAL_FILE.test(path)) return null;
  return PAGE_FILE.test(path) ? "ui" : "image";
}

function isSmallEdit(toolName: string, input: Record<string, unknown>): boolean {
  return toolName === "edit" && editText(toolName, input).split("\n").length <= SMALL_EDIT_LINES;
}

/** A look/ui_audit target that is the model's own page (not a reference picture). */
function ownPage(target: unknown): string | null {
  if (typeof target !== "string" || !target) return null;
  if (target.includes(".pi/design-refs/")) return null;
  return /^https?:\/\//i.test(target) || /\.(html?|xhtml)$/i.test(target) ? target : null;
}

export class TasteGuard {
  /** Session-wide: references exist (on disk, collected, or given by the user). */
  private researched = false;
  // Per run:
  private seq = 0;
  private visualSeq = 0;
  private visual: VisualKind | null = null;
  private target: string | null = null;
  private auditSeq = 0;
  private auditHigh = 0;
  private auditNudges = 0;
  private researchBlocks = 0;
  private rounds = 0;
  private critiqued = 0;
  private lastImage: { data: string; mimeType: string } | null = null;

  constructor(private readonly cwd: () => string) {}

  /** References already exist on disk (checked by the gateway) or the user attached a picture. */
  markResearched(): void {
    this.researched = true;
  }

  get hasResearch(): boolean {
    return this.researched;
  }

  startRun(): void {
    this.seq = 0;
    this.visualSeq = 0;
    this.visual = null;
    this.target = null;
    this.auditSeq = 0;
    this.auditHigh = 0;
    this.auditNudges = 0;
    this.researchBlocks = 0;
    this.rounds = 0;
    this.critiqued = 0;
    this.lastImage = null;
  }

  /**
   * tool_call: block the first real visual change until references were collected —
   * once per run: a model with a good reason to skip (a diagram) says so and retries.
   */
  beforeTool(toolName: string, input: Record<string, unknown>, research: "auto" | "ask" | "off"): string | null {
    if (research === "off" || this.researched || this.researchBlocks >= 1) return null;
    const kind = visualChange(toolName, input);
    if (!kind || isSmallEdit(toolName, input)) return null;
    // Diagrams are laid out by Graphviz/Mermaid — nothing to be inspired by.
    if (/\.(dot|gv|mmd|mermaid)$/i.test(String(input.path ?? input.file_path ?? ""))) return null;
    this.researchBlocks++;
    const how =
      kind === "ui"
        ? 'design_refs with kind "ui" and a specific query for what you are building (e.g. "artisan bakery website", "kanban app for small teams")'
        : 'design_refs with kind "image" and a specific query for the subject and style (e.g. "stylized goblin 3d character", "low poly medieval windmill")';
    return (
      "Taste: before the first visual change, look for references. " +
      `Call ${how}. Pick the ones that look best for this task, write the brief.md it asks for, then build to it. ` +
      "If references make no sense here (the user gave one, it's a chart or diagram), say why in one sentence and retry. design_refs is loaded now."
    );
  }

  /** tool_result: record visual changes, what was looked at, audit results. */
  afterTool(toolName: string, input: Record<string, unknown>, isError: boolean, content: { type: string; data?: string; mimeType?: string }[] = []): void {
    this.seq++;
    if (isError) return;
    const kind = visualChange(toolName, input);
    if (kind) {
      this.visualSeq = this.seq;
      // A page wins over "image": a UI run that also touched an SVG icon is still a UI run.
      if (this.visual !== "ui") this.visual = kind;
      const path = String(input.path ?? input.file_path ?? "");
      if (!this.target && /\.(html?|xhtml)$/i.test(path)) this.target = this.abs(path);
    }
    if (toolName === "design_refs") this.researched = true;
    if (toolName === "look" || toolName === "ui_audit") {
      const page = ownPage(input.target);
      if (page) this.target = /^https?:/i.test(page) ? page : this.abs(page);
    }
    if (toolName === "look_compare") {
      const page = ownPage(input.b);
      if (page) this.target = /^https?:/i.test(page) ? page : this.abs(page);
    }
    // The newest picture of the model's own work (3D screenshots, look at its own render).
    const img = content.find((c) => c.type === "image" && c.data);
    const aboutRefs = typeof input.target === "string" && input.target.includes(".pi/design-refs/");
    if (img && toolName !== "design_refs" && !aboutRefs) this.lastImage = { data: img.data!, mimeType: img.mimeType ?? "image/png" };
  }

  /** ui_audit finished (the gateway knows the counts). */
  recordAudit(high: number): void {
    this.auditSeq = this.seq + 1; // afterTool for this call runs next and bumps seq
    this.auditHigh = high;
  }

  get image(): { data: string; mimeType: string } | null {
    return this.lastImage;
  }

  get visualKind(): VisualKind | null {
    return this.visual;
  }

  private abs(p: string): string {
    const clean = p.startsWith("@") ? p.slice(1) : p;
    return isAbsolute(clean) ? resolve(clean) : resolve(this.cwd(), clean);
  }

  /**
   * agent_before_settle, after the constitution passed: audit first (cheap, objective),
   * then one critic round. `criticDone` tells the guard the critic ran (and its verdict).
   */
  beforeSettle(opts: { requireAudit: boolean; critic: boolean; maxRounds: number; maxAuditNudges: number }): SettleStep {
    if (!this.visual || this.visualSeq === 0) return null;
    if (this.visual === "ui" && opts.requireAudit && this.auditNudges < opts.maxAuditNudges) {
      const stale = this.auditSeq < this.visualSeq;
      if (stale || this.auditHigh > 0) {
        this.auditNudges++;
        const where = this.target ? `on ${this.target.startsWith(`${this.cwd()}/`) ? this.target.slice(this.cwd().length + 1) : this.target}` : "on your page (dev-server URL or .html file)";
        return {
          kind: "nudge",
          nudge: stale
            ? {
                label: "Gust: wymuszony ui_audit po zmianie wyglądu",
                content: `[Taste: measure]\nYou changed the page but have not measured it since. Run ui_audit ${where}, fix every HIGH item (and MEDIUM where easy), then run it again.`,
              }
            : {
                label: `Gust: ${this.auditHigh} poważn${this.auditHigh === 1 ? "y problem" : "e problemy"} z ui_audit`,
                content: `[Taste: measure]\nThe last ui_audit still lists ${this.auditHigh} HIGH problem(s). Fix them and run ui_audit ${where} again. If one is intentional, say which and why.`,
              },
        };
      }
    }
    if (!opts.critic || this.critiqued >= this.visualSeq) return null;
    if (this.rounds >= opts.maxRounds) return null;
    return { kind: "critic", visual: this.visual, target: this.target };
  }

  /** The critic ran on the current state; ISSUES opens another round. */
  criticDone(ok: boolean): { round: number } {
    this.critiqued = this.visualSeq;
    this.rounds++;
    if (ok) this.rounds = Number.POSITIVE_INFINITY;
    return { round: this.rounds };
  }

  /** Rounds used up with the critic still unhappy. */
  exhausted(maxRounds: number): boolean {
    return Number.isFinite(this.rounds) && this.rounds >= maxRounds && this.critiqued < this.visualSeq;
  }
}
