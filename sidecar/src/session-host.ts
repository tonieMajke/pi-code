import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createAgentSession,
  createAgentSessionServices,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  ApprovalDecision,
  Attachment,
  ForkPoint,
  HistoryItem,
  HistoryPart,
  PermissionMode,
  Perf,
  PiEvent,
  RequestRole,
  RequestStats,
  SessionStats,
  SessionStatus,
  SlashCommandInfo,
  Usage,
} from "../../shared/protocol.js";
import { withMidrunNote } from "../../shared/midrun.js";
import { ExtensionDialogs } from "./extension-ui.js";
import { AnswerFirst } from "./answer-first.js";
import { decide, foreignKill, PLAN_PROMPT, riskyAction, startedByApp, unwrapMcp } from "./permissions.js";
import { repairEdit } from "./editfix.js";
import { ProgressWatch } from "./progress.js";
import { TurnLimit } from "./turn-limit.js";
import { appContext } from "./app-context.js";
import { PlanRecital, TODO_DESCRIPTION, TodoList, type TodoItem } from "./todo.js";
import { CONSTITUTION_MESSAGE_TYPE, ConstitutionGuard, finishIntent } from "./constitution.js";
import type { GuiConfigStore } from "./config.js";
import { createSession } from "./session-files.js";
import { bashPrefixes, coveredByPrefixes } from "../../shared/shell.js";
import { changesSince, diffSince, restore, snapshot } from "./checkpoint.js";
import { elideOldImages, elideOldToolOutput } from "./elide.js";
import { changedLines, parseVerdict, reviewNudge, reviewPrompt, type ReviewVerdict } from "./review.js";
import { isLocalBaseUrl, withRequestContext, withSlot, type RequestContext } from "./perf.js";
import { look, LOOK_COMPARE_DESCRIPTION, LOOK_DESCRIPTION, lookCompare } from "./look.js";
import { AUDIT_DESCRIPTION, countBySeverity, formatAudit, uiAudit } from "./audit.js";
import { designRefs, DESIGN_REFS_DESCRIPTION, hasRefs, refsRoot, topicSlug } from "./refs.js";
import { TasteGuard, type VisualKind } from "./taste.js";
import { CRITIC_SYSTEM_PROMPT, criticNudge, criticPrompt, pageOutline, pickReference } from "./critic.js";
import { open as openPage, withPage } from "./browser.js";
import { memoryPrompt, type MemoryStore } from "./memory.js";
import { plural, t } from "../../shared/i18n.js";

const run = promisify(execFile);

/** bash calls without their own timeout get this one; builds that need longer must say so. */
const DEFAULT_BASH_TIMEOUT_S = 180;

/** Tool output kept for the UI (bash logs can be long; the card scrolls). */
const TOOL_TEXT_MAX = 8000;

export type AgentMessage = AgentSession["state"]["messages"][number];
export type Services = Awaited<ReturnType<typeof createAgentSessionServices>>;
type Model = NonNullable<AgentSession["model"]>;
const SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));

/** Meta-tool that loads deferred tools. */
export const ENABLE_TOOLS = "enable_tools";

/** Custom session entry with a run's request timings — the turn footer survives reopening. */
const STATS_ENTRY = "pi-gui-stats";
type StatsEntryData = { after: number; stats: RequestStats[] };

function firstSentence(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const m = /^(.{20,160}?[.!?])(\s|$)/.exec(line);
  return m ? m[1] : line.slice(0, 140);
}

/** What a session needs from the registry that owns it (PiGateway). */
export interface HostEnv {
  readonly services: Services;
  readonly config: GuiConfigStore;
  readonly memory: MemoryStore | null;
  /** Permission mode — GUI-wide, read live so a background session follows a change too. */
  mode(): PermissionMode;
  /** Every event of this session; the registry forwards it only while the session is on screen. */
  emit(host: SessionHost, e: PiEvent): void;
  /** Events that are not about one session (session list changed…). */
  emitGlobal(e: PiEvent): void;
  activeHost(): SessionHost | null;
  modelByKey(key: string): Model;
  isRealModel(m: AgentSession["model"]): boolean;
  /** A run is starting: background memory learning must give the model server back. */
  runStarting(host: SessionHost): void;
  /** A run ended (the registry may release idle sessions and learn now). */
  settled(host: SessionHost): void;
  /** Session swaps started by an extension command (/new, /fork, /resume…). */
  startSession(cwd: string, sm: SessionManager): Promise<void>;
  branchInto(host: SessionHost, leafId: string | null): Promise<void>;
  openSession(path: string): Promise<void>;
}

/**
 * One live pi session with everything that belongs to it: the agent, its GUI extension
 * (permission gate, guards, tools), pending approvals and dialogs, run state. Several
 * can be alive at once; the registry decides which one the UI sees.
 */
export class SessionHost {
  session!: AgentSession;
  /** True from prompt() call until it resolves — covers the gap before isStreaming flips. */
  private running = false;
  /**
   * prompt() was called but the run has not started (extensions still loading, MCP can take
   * seconds). Messages sent meanwhile wait here: handing them to the SDK as mid-run steering
   * would mark them "sent while you were working" and force a text-only reply to a turn that
   * never happened. They go out as ordinary follow-ups at the first turn_start.
   */
  private starting = false;
  private early: { text: string; images?: Attachment[] }[] = [];
  private disposed = false;
  private taste: TasteGuard | null = null;
  private guard: ConstitutionGuard | null = null;
  /** Tool names the user approved "always" for this session. */
  private alwaysAllowed = new Set<string>();
  /** bash is remembered by command prefix ("pnpm test"), never as a whole. */
  private alwaysBash = new Set<string>();
  /** After an interruption or a mid-run message, the next reply is text only. */
  private answerFirst = new AnswerFirst();
  private pendingApprovals = new Map<
    string,
    { resolve: (d: { decision: ApprovalDecision; reason?: string }) => void; toolName: string; args: unknown; risk?: string; note?: string }
  >();
  /** Risky commands already sent back once for an explanation — the second try goes to the card as is. */
  private explainAsked = new Set<string>();
  /** Deferred tools the model loaded in this session. */
  private onDemand = new Set<string>();
  /** Worktree snapshot taken when the current run started (git projects only). */
  private runCheckpoint: string | null = null;
  private reviewer: AgentSession | null = null;
  handoffAbort: AbortController | null = null;
  /** Extensions' session_start (MCP connects etc.) runs after the session is shown; a prompt waits for it. */
  extensionsReady: Promise<void> = Promise.resolve();
  /** An extension switch came in mid-turn; applied when the turn settles. */
  private reloadPending = false;
  /** ctx.ui dialogs of pi extensions, answered in the GUI. */
  private dialogs = new ExtensionDialogs((e) => this.onDialogEvent(e));
  /** Agent runs that reached agent_settled — tells prompt() whether a "/command" ran the agent at all. */
  private settledRuns = 0;
  /** Timings of the current run's own requests (not the critic's), saved into the session at settle. */
  private runStats: RequestStats[] = [];
  status: SessionStatus = "idle";
  /** When the current run started (ms). */
  busySince: number | null = null;
  /** Last time the user had it on screen — the oldest idle one is released first. */
  lastSeen = Date.now();
  /** First message of a run on an empty session: the title before pi adds it to the messages. */
  private firstPrompt = "";
  /** Last queue sizes, replayed when the session comes back on screen. */
  private queue = { steering: 0, followUp: 0 };

  private constructor(
    private readonly env: HostEnv,
    public cwd: string,
  ) {}

  /** Load extensions for the project, create the agent, hook it up. */
  static async start(env: HostEnv, cwd: string, sessionManager: SessionManager, model: Model | undefined): Promise<SessionHost> {
    const host = new SessionHost(env, cwd);
    // One loader per session: project context files and extensions are cwd-bound,
    // and this is where the GUI's own inline extension (permission gate) is attached.
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: env.services.agentDir,
      settingsManager: env.services.settingsManager,
      extensionFactories: [{ name: "pi-gui", hidden: true, factory: host.extension }],
      // Extensions switched off in Pi Code (add-ons pop-up); read on every reload.
      extensionsOverride: (base) => ({
        ...base,
        extensions: base.extensions.filter((e) => e.hidden || !env.config.extensionDisabled(extensionName(e.resolvedPath))),
      }),
      // GUI-bundled skills (visual design rules etc.), loaded on demand like any pi skill.
      additionalSkillPaths: [SKILLS_DIR],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      model,
      modelRuntime: env.services.modelRuntime,
      settingsManager: env.services.settingsManager,
      sessionManager,
      resourceLoader,
    });
    host.session = session;
    host.applyToolPolicy();
    host.subscribe();
    // Not awaited: switching sessions must not wait for extensions (~200 ms, more with MCP).
    host.extensionsReady = host.bindExtensions().catch((err: unknown) =>
      host.emit({ kind: "notice", level: "error", text: `${t("Start rozszerzeń")}: ${err instanceof Error ? err.message : String(err)}` }),
    );
    return host;
  }

  /** Wrap an already created session (tests use fakes; no extensions are bound). */
  static adopt(env: HostEnv, cwd: string, session: AgentSession): SessionHost {
    const host = new SessionHost(env, cwd);
    host.session = session;
    host.subscribe();
    return host;
  }

  /** Timings of one of this session's own requests (role main), saved into the file at settle. */
  addRunStats(stats: RequestStats): void {
    this.runStats.push(stats);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get id(): string {
    return this.session.sessionId;
  }

  get path(): string {
    return this.session.sessionFile ?? "";
  }

  /** Sidebar title: the name, else the first user message. */
  get title(): string {
    if (this.session.sessionName) return this.session.sessionName;
    const first = this.session.state.messages.find((m) => m.role === "user");
    const text = first?.role === "user" ? userText(first.content as Parameters<typeof userText>[0]) : this.firstPrompt;
    return text.replace(/\s+/g, " ").trim().slice(0, 80);
  }

  get busy(): boolean {
    return this.running || this.session.state.isStreaming;
  }

  /** Runs on a model served from this machine / private network (shares its slots). */
  get isLocal(): boolean {
    return isLocalBaseUrl((this.session.model as { baseUrl?: string } | undefined)?.baseUrl);
  }

  /** Base URL of the model's provider (llama-server router), if it has one. */
  get baseUrl(): string | undefined {
    return (this.session.model as { baseUrl?: string } | undefined)?.baseUrl;
  }

  private get config(): GuiConfigStore {
    return this.env.config;
  }

  private get mode(): PermissionMode {
    return this.env.mode();
  }

  emit(e: PiEvent): void {
    if (e.kind === "queue") this.queue = { steering: e.steering, followUp: e.followUp };
    this.env.emit(this, e);
    if (e.kind === "settled") {
      this.busySince = null;
      this.setStatus(this.env.activeHost() === this ? "idle" : this.failed() ? "error" : "done");
      this.env.settled(this);
      if (this.reloadPending) this.extensionsChanged();
    }
  }

  setStatus(status: SessionStatus): void {
    if (this.disposed || status === this.status) return;
    this.status = status;
    this.env.emit(this, this.statusEvent());
  }

  statusEvent(): Extract<PiEvent, { kind: "session_status" }> {
    return { kind: "session_status", session: this.id, path: this.path, cwd: this.cwd, title: this.title, status: this.status };
  }

  /** The last answer ended in an error (API refused, server down…). */
  private failed(): boolean {
    const last = [...this.session.state.messages].reverse().find((m) => m.role === "assistant");
    return last?.role === "assistant" && (last as { stopReason?: string }).stopReason === "error";
  }

  /** Live speed of this session's request (the registry routes by request context). */
  onPerf(perf: Perf, role: RequestRole | undefined): void {
    if (this.busy && (this.status === "working" || this.status === "slot")) this.setStatus(perf.phase === "waiting" ? "slot" : "working");
    this.emit({ kind: "perf", perf, role });
  }

  private onDialogEvent(e: PiEvent): void {
    if (e.kind === "ui_request") this.setStatus("approval");
    if (e.kind === "ui_done" && this.busy && !this.pendingApprovals.size && !this.dialogs.open.length) this.setStatus("working");
    this.emit(e);
  }

  /** The UI answered an extension dialog. */
  answerDialog(requestId: string, answer: Parameters<ExtensionDialogs["answer"]>[1]): boolean {
    if (!this.dialogs.has(requestId)) return false;
    this.dialogs.answer(requestId, answer);
    if (this.busy && !this.pendingApprovals.size && !this.dialogs.open.length) this.setStatus("working");
    return true;
  }

  hasApproval(toolCallId: string): boolean {
    return this.pendingApprovals.has(toolCallId);
  }

  /** Request context for side calls made on behalf of this session. */
  private ctx(role: RequestRole): RequestContext {
    return { sessionId: this.session.sessionId, cwd: this.cwd, role };
  }

  /** Brought back on screen: approvals, dialogs and the queue the UI dropped while it was elsewhere. */
  replay(): void {
    for (const [toolCallId, p] of this.pendingApprovals) this.emit({ kind: "approval_request", toolCallId, toolName: p.toolName, args: p.args, risk: p.risk, note: p.note });
    for (const request of this.dialogs.open) this.emit({ kind: "ui_request", request });
    if (this.queue.steering || this.queue.followUp) this.emit({ kind: "queue", ...this.queue });
  }

  /** Rendered transcript, including a message still streaming and tools still running. */
  historyItems(): HistoryItem[] {
    const st = this.session.state as AgentSession["state"] & { streamingMessage?: AgentMessage; pendingToolCalls?: ReadonlySet<string> };
    const messages = st.streamingMessage && !st.messages.includes(st.streamingMessage) ? [...st.messages, st.streamingMessage] : st.messages;
    return historyOf(this.id, messages, statsEntries(this.session.sessionManager), st.pendingToolCalls, this.busy);
  }

  historyMessages(): readonly AgentMessage[] {
    const st = this.session.state as AgentSession["state"] & { streamingMessage?: AgentMessage };
    return st.streamingMessage && !st.messages.includes(st.streamingMessage) ? [...st.messages, st.streamingMessage] : st.messages;
  }


  /** Resolve a pending approval prompt from the UI. Unknown ids are ignored (already settled). */
  approve(toolCallId: string, decision: ApprovalDecision, reason?: string): void {
    const pending = this.pendingApprovals.get(toolCallId);
    if (!pending) return;
    this.pendingApprovals.delete(toolCallId);
    pending.resolve({ decision, reason });
    if (this.busy && !this.pendingApprovals.size && !this.dialogs.open.length) this.setStatus("working");
  }

  private denyAllPending(): void {
    for (const id of [...this.pendingApprovals.keys()]) this.approve(id, "deny", "run aborted");
  }

  /** Visible text the model wrote in the message that makes this tool call (its explanation), or undefined. */
  private explanationFor(toolCallId: string): string | undefined {
    const msgs = this.historyMessages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i] as { role?: string; content?: unknown };
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      const blocks = m.content as { type?: string; text?: string; id?: string }[];
      if (!blocks.some((b) => b.type === "toolCall" && b.id === toolCallId)) continue;
      const text = blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text!.trim())
        .filter(Boolean)
        .join("\n\n");
      return text.length >= 20 ? text : undefined;
    }
    return undefined;
  }

  /** pi `tool_call` hook: returns a block result or undefined (allowed). */
  async gate(toolCallId: string, toolName: string, input: Record<string, unknown>) {
    const call = unwrapMcp(toolName, input);
    const verdict = decide(this.mode, call.name, call.args);
    if (verdict.kind === "block") return { block: true, reason: verdict.reason };
    // Signalling a process this app did not start, and risky actions (system, browser settings,
    // downloads, publishing, writing outside the project) ask in every mode, "always allow" included.
    const killing = toolName === "bash" && typeof input.command === "string" ? foreignKill(input.command, startedByApp) : null;
    const risky = killing ? null : riskyAction(call, this.cwd);
    if (killing) this.emit({ kind: "guard", label: t("Zabijanie procesu spoza Pi Code — pytam ({what})", { what: killing }) });
    else if (risky) this.emit({ kind: "guard", label: t("Ryzykowna akcja — pytam ({what})", { what: risky }) });
    else {
      if (verdict.kind === "allow") return undefined;
      if (call.name === "bash" ? coveredByPrefixes(String(call.args.command ?? ""), this.alwaysBash) : this.alwaysAllowed.has(call.key)) return undefined;
    }

    const risk = killing ?? risky ?? undefined;
    const note = risk ? this.explanationFor(toolCallId) : undefined;
    if (risk && !note && call.name === "bash") {
      // The user decides on a risky command from the card: the model has to say what it does first.
      const key = String(call.args.command ?? "");
      if (!this.explainAsked.has(key)) {
        this.explainAsked.add(key);
        this.emit({ kind: "guard", label: t("Ryzykowne polecenie bez wyjaśnienia — model ma je najpierw opisać") });
        return {
          block: true,
          reason:
            `Not run: this command is risky (${risk}) and the user must approve it. First write in visible text ` +
            `the exact command in a code block and one or two plain sentences on what it does, what it changes ` +
            `and what could go wrong. Then call it again, unchanged.`,
        };
      }
    }

    const answer = await new Promise<{ decision: ApprovalDecision; reason?: string }>((resolve) => {
      this.pendingApprovals.set(toolCallId, { resolve, toolName, args: input, risk, note });
      this.setStatus("approval");
      this.emit({ kind: "approval_request", toolCallId, toolName, args: input, risk, note });
    });
    this.emit({ kind: "approval_done", toolCallId, decision: answer.decision });
    if (answer.decision === "always" && !killing && !risky) {
      // A command that cannot be remembered by prefix (inline code, substitutions) is allowed once.
      if (call.name === "bash") for (const p of bashPrefixes(String(call.args.command ?? "")) ?? []) this.alwaysBash.add(p);
      else this.alwaysAllowed.add(call.key);
    }
    if (answer.decision === "deny") {
      return {
        block: true,
        reason: answer.reason
          ? `The user denied this tool call and said: ${answer.reason}`
          : "The user denied this tool call. Ask what they want instead of retrying it.",
      };
    }
    return undefined;
  }

  /** Inline extension: the GUI's hooks into pi's agent loop. */
  private extension = (pi: ExtensionAPI) => {
    // One guard per session: the factory runs once per resource loader.
    const guard = new ConstitutionGuard(() => this.cwd);
    const taste = new TasteGuard(() => this.cwd);
    const progress = new ProgressWatch(() => this.cwd);
    const todo = new TodoList();
    const recital = new PlanRecital();
    const limit = new TurnLimit();
    /** toolCallId → status request appended to that call's result. */
    const statusAsk = new Map<string, string>();
    /** The plan was written or updated in this run (a stale plan from an old task is not enforced). */
    let todoTouched = false;
    let todoNudges = 0;
    this.taste = taste;
    this.guard = guard;
    let stopNoted = false;
    let task = "";
    let reviewed = false;
    /** The reviewer or the critic already sent the model back once this run: no second round. */
    let extraRound = false;
    const tasteOn = () => cfg().taste.enabled;
    /** Load deferred tools without the model asking (the taste guard needs design_refs etc.). */
    const loadTools = (names: string[]) => {
      const known = new Set(this.session.getAllTools().map((t) => t.name));
      const ok = names.filter((n) => known.has(n) && this.config.toolPolicy(n) !== "off");
      ok.forEach((n) => this.onDemand.add(n));
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...ok])]);
    };
    const cfg = () => this.config.get();
    const hard = () => cfg().constitution.enabled && cfg().constitution.hard;

    // Deferred tools: listed by name in the system prompt, loaded on request.
    pi.registerTool({
      name: ENABLE_TOOLS,
      label: t("Włącz narzędzia"),
      description:
        "Load tools that are available on demand (see 'On-demand tools' in the system prompt). " +
        "Their full definitions become usable from your next step.",
      parameters: Type.Object({
        names: Type.Array(Type.String(), { description: "Tool names to load" }),
      }),
      execute: async (_id, params) => {
        const known = new Set(this.session.getAllTools().map((t) => t.name));
        const ok = params.names.filter((n) => known.has(n) && this.config.toolPolicy(n) !== "off");
        const bad = params.names.filter((n) => !ok.includes(n));
        ok.forEach((n) => this.onDemand.add(n));
        pi.setActiveTools([...new Set([...pi.getActiveTools(), ...ok])]);
        const text =
          (ok.length ? `Loaded: ${ok.join(", ")}. Use them from your next step.` : "Nothing loaded.") +
          (bad.length ? ` Unknown or disabled: ${bad.join(", ")}.` : "");
        return { content: [{ type: "text", text }], details: undefined };
      },
    });

    pi.on("message_end", (event) => {
      const m = event.message as { role?: string; content?: unknown };
      if (m.role !== "assistant" || !Array.isArray(m.content)) return undefined;
      const blocks = m.content as { type?: string; text?: string }[];
      // Text the user can read resets the silent-chain limit; a message of tool calls is a step.
      limit.messageEnd(blocks.some((b) => b.type === "text" && !!b.text?.trim()));
      // Some providers stream thousands of empty text parts (one session file: 2465 of them).
      const kept = blocks.filter((b) => b.type !== "text" || !!b.text);
      if (kept.length === blocks.length || kept.length === 0) return undefined;
      return { message: { ...event.message, content: kept } as typeof event.message };
    });

    pi.on("tool_call", async (event, ctx) => {
      const input = event.input as Record<string, unknown>;
      const silent = limit.beforeTool(cfg().turnLimit);
      if (silent?.label) this.emit({ kind: "guard", label: silent.label });
      // The call runs; the status request rides on its result (once per message — the first call).
      if (silent?.kind === "status" && silent.label) statusAsk.set(event.toolCallId, silent.reason);
      if (silent?.kind === "stop") {
        setTimeout(() => void this.abort(), 0); // not from inside the run's own hook
        return { block: true, reason: "Pi Code stopped the run: no status after the limit." };
      }
      // Constitution first: no point asking the user to approve a call that gets blocked anyway.
      const reason = hard() ? guard.beforeTool(event.toolName, input) : null;
      if (reason) return { block: true, reason };
      if (tasteOn() && this.mode !== "plan") {
        let research = cfg().taste.research;
        if (research === "ask" && taste.beforeTool(event.toolName, input, "auto") !== null) {
          // beforeTool counted a block; the user decides whether it stands.
          const yes = t("Tak");
          const always = t("Zawsze szukaj");
          const never = t("Nigdy nie szukaj");
          const choice = await ctx.ui.select(t("Poszukać wzorców przed pracą wizualną?"), [yes, t("Nie, tym razem"), always, never]);
          if (choice === always) this.config.update("taste", { research: "auto" });
          if (choice === never) this.config.update("taste", { research: "off" });
          if (choice === yes || choice === always) {
            loadTools(["design_refs"]);
            return { block: true, reason: "Taste: the user wants references first. Call design_refs (kind and a specific query), write brief.md, then build." };
          }
          taste.markResearched();
          research = "off";
        }
        const tasteReason = research === "auto" ? taste.beforeTool(event.toolName, input, research) : null;
        if (tasteReason) {
          loadTools(["design_refs"]);
          this.emit({ kind: "guard", label: t("Gust: najpierw wzorce, potem budowanie") });
          return { block: true, reason: tasteReason };
        }
      }
      progress.beforeTool(event.toolName, input);
      // A command without a time limit can hang the whole turn for minutes (watchers, prompts, servers).
      if (event.toolName === "bash" && input.timeout === undefined) input.timeout = DEFAULT_BASH_TIMEOUT_S;
      if (event.toolName === "edit" && !process.env.PI_GUI_NO_EDITFIX) {
        // Small models get the code right and the whitespace wrong, or edit from memory.
        const fix = repairEdit(input, this.cwd);
        if (fix && "block" in fix) {
          this.emit({ kind: "guard", label: t("Edycja: tekstu nie ma w pliku — pokazano najbliższy fragment") });
          return { block: true, reason: fix.block };
        }
        if (fix) this.emit({ kind: "guard", label: t("Edycja: poprawiono wcięcia ({what})", { what: fix.fixed }) });
      }
      return this.gate(event.toolCallId, event.toolName, input);
    });
    pi.on("tool_result", (event) => {
      const hasImage = event.content.some((c) => c.type === "image");
      guard.afterTool(event.toolName, event.input, event.isError, hasImage);
      taste.afterTool(event.toolName, event.input, event.isError, event.content as { type: string; data?: string; mimeType?: string }[]);
      // Visual work started: the measuring tools come along without the model asking.
      if (tasteOn() && taste.visualKind === "ui") loadTools(["ui_audit", "look_compare"]);
      if (tasteOn() && taste.visualKind === "image") loadTools(["look_compare"]);
      const output = event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      const note = hard() ? progress.afterTool(event.toolName, event.input, event.isError, output) : null;
      if (note) this.emit({ kind: "guard", label: t("Postęp: model kręci się w kółko — dostał sygnał do zmiany podejścia") });
      const ask = statusAsk.get(event.toolCallId);
      statusAsk.delete(event.toolCallId);
      const extra = [note, ask].filter((x): x is string => !!x);
      if (!extra.length) return undefined;
      return { content: [...event.content, ...extra.map((text) => ({ type: "text" as const, text: `\n\n${text}` }))] };
    });

    pi.registerTool({
      name: "todo",
      label: t("Plan"),
      description: TODO_DESCRIPTION,
      parameters: Type.Object({
        items: Type.Array(
          Type.Object({
            text: Type.String(),
            status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done"), Type.Literal("skipped")]),
          }),
        ),
      }),
      execute: async (_id, params) => {
        const err = todo.set(params.items as TodoItem[]);
        if (err) throw new Error(err);
        todoTouched = true;
        return { content: [{ type: "text", text: todo.all.length ? `Plan saved.\n${todo.render()}` : "Plan cleared." }], details: undefined };
      },
    });

    pi.registerTool({
      name: "look",
      label: t("Podgląd"),
      description: LOOK_DESCRIPTION,
      parameters: Type.Object({
        target: Type.String({ description: "URL (http://localhost:5173/…) or a file path: .html, .svg, .dot/.gv, .mmd, .png/.jpg" }),
        width: Type.Optional(Type.Number({ description: "Viewport width in px (default 1280)" })),
        height: Type.Optional(Type.Number({ description: "Viewport height in px (default 800)" })),
        fullPage: Type.Optional(Type.Boolean({ description: "Capture the whole scrolling page (pages only)" })),
        crop: Type.Optional(
          Type.Object(
            { x: Type.Number(), y: Type.Number(), w: Type.Number(), h: Type.Number() },
            { description: "Zoom into a region (page px), shown at 2x — for checking small details" },
          ),
        ),
      }),
      execute: async (_id, params) => {
        const r = await look(params, this.cwd);
        return {
          content: [
            { type: "image", data: r.data, mimeType: r.mimeType },
            { type: "text", text: `${r.note}. Look critically: alignment, spacing, contrast, overlaps, anything cut off, and whether it matches the request.` },
          ],
          details: undefined,
        };
      },
    });

    pi.registerTool({
      name: "look_compare",
      label: t("Porównanie"),
      description: LOOK_COMPARE_DESCRIPTION,
      parameters: Type.Object({
        a: Type.String({ description: "Left: the reference (e.g. .pi/design-refs/<topic>/01-….png)" }),
        b: Type.String({ description: "Right: your work — page URL, .html, or an image file" }),
        width: Type.Optional(Type.Number({ description: "Render width in px (default 1280)" })),
      }),
      execute: async (_id, params) => {
        const r = await lookCompare(params, this.cwd);
        return {
          content: [
            { type: "image", data: r.data, mimeType: r.mimeType },
            { type: "text", text: `${r.note}. List the concrete differences that make the right side look worse (spacing, hierarchy, type, colour, detail) and fix the top 3.` },
          ],
          details: undefined,
        };
      },
    });

    pi.registerTool({
      name: "ui_audit",
      label: t("Audyt UI"),
      description: AUDIT_DESCRIPTION,
      parameters: Type.Object({
        target: Type.String({ description: "Your page: dev-server URL or .html file" }),
        width: Type.Optional(Type.Number({ description: "Desktop width in px (default 1280); 390 px is always checked too" })),
      }),
      execute: async (_id, params) => {
        const r = await uiAudit(params, this.cwd);
        taste.recordAudit(countBySeverity(r.issues).high);
        return { content: [{ type: "text", text: formatAudit(r) }], details: undefined };
      },
    });

    pi.registerTool({
      name: "design_refs",
      label: t("Wzorce"),
      description: DESIGN_REFS_DESCRIPTION,
      parameters: Type.Object({
        topic: Type.String({ description: "Short folder name for this set, e.g. \"bakery-home\", \"goblin\"" }),
        kind: Type.Union([Type.Literal("ui"), Type.Literal("image")], { description: "ui = websites/apps; image = pictures of any subject (3D, illustration)" }),
        query: Type.String({ description: "Specific search, e.g. \"artisan sourdough bakery website\" or \"stylized goblin 3d character\"" }),
        urls: Type.Optional(Type.Array(Type.String(), { description: "Use exactly these pages (ui) or image URLs (image) instead of searching" })),
      }),
      execute: async (_id, params) => {
        const r = await designRefs(params, this.cwd);
        const content: ({ type: "image"; data: string; mimeType: string } | { type: "text"; text: string })[] = [];
        if (r.sheet) content.push({ type: "image", data: readFileSync(r.sheet).toString("base64"), mimeType: "image/jpeg" });
        content.push({ type: "text", text: r.text });
        return { content, details: undefined };
      },
    });

    // The user says "remember that…" — the model writes it down itself.
    pi.registerTool({
      name: "remember",
      label: t("Pamięć"),
      description:
        "Save a durable fact about the user to long-term memory (carried into every future session). " +
        "Use when the user asks you to remember something, or states a lasting preference about how you should work. " +
        "One short sentence per call, in the user's language. Never store secrets.",
      parameters: Type.Object({ fact: Type.String({ description: "One short sentence, e.g. \"Prefers answers in Polish.\"" }) }),
      execute: async (_id, params) => {
        if (!this.memoryActive()) return { content: [{ type: "text", text: "Memory is turned off." }], details: undefined };
        const added = this.env.memory!.add([params.fact]);
        this.emit({ kind: "memory", added });
        return { content: [{ type: "text", text: added.length ? "Saved to memory." : "Already in memory." }], details: undefined };
      },
    });

    pi.on("before_provider_request", (event) => {
      const payload = this.answerFirst.apply(event.payload);
      if (!payload) return undefined;
      this.emit({ kind: "guard", label: t("Przerwano — model najpierw odpowiada (narzędzia wyłączone na tę odpowiedź)") });
      return payload;
    });

    pi.on("before_agent_start", async (event) => {
      this.answerFirst.startRun();
      guard.startRun();
      limit.reset();
      statusAsk.clear();
      taste.startRun();
      progress.startRun();
      todoTouched = false;
      todoNudges = 0;
      // A finished plan is history; an unfinished one carries over to a follow-up.
      if (!todo.open.length) todo.clear();
      stopNoted = false;
      if (finishIntent(event.prompt)) {
        guard.userFinish();
        taste.userSpoke();
      }
      if (hasRefs(this.cwd)) taste.markResearched();
      // A picture the user attached is the reference — no search needed.
      if (tasteOn() && event.images?.length) {
        try {
          const dir = join(refsRoot(this.cwd), topicSlug(event.prompt.split(/\s+/).slice(0, 4).join(" ")));
          mkdirSync(dir, { recursive: true });
          event.images.forEach((img, i) => writeFileSync(join(dir, `00-user${i ? `-${i}` : ""}.${img.mimeType.split("/")[1] ?? "png"}`), Buffer.from(img.data, "base64")));
          taste.markResearched();
        } catch {
          /* read-only project etc. — the picture is still in the conversation */
        }
      }
      task = event.prompt;
      reviewed = false;
      extraRound = false;
      this.runCheckpoint = await snapshot(this.cwd, task.slice(0, 60)).catch(() => null);
      const extra = [
        appContext(),
        cfg().constitution.enabled ? this.config.constitutionText : "",
        this.toolCatalog(),
        this.memoryActive() ? memoryPrompt(this.env.memory!.read()) : "",
      ].filter(Boolean);
      return {
        systemPrompt: extra.length ? `${event.systemPrompt}\n\n${extra.join("\n\n")}` : undefined,
        message:
          this.mode === "plan" ? { customType: "pi-gui-plan-mode", content: PLAN_PROMPT, display: false } : undefined,
      };
    });

    // The run may not end with unverified edits, a failing check, or unreviewed changes.
    pi.on("agent_before_settle", async (event) => {
      if (event.outcome !== "completed" || this.mode === "plan") return undefined;
      // The reply to an interruption ends the run: the user decides what happens next.
      if (this.answerFirst.answered) return undefined;
      const back = (content: string, label: string) => {
        this.emit({ kind: "guard", label });
        return {
          entries: [
            { type: "custom_message" as const, customType: CONSTITUTION_MESSAGE_TYPE, content, display: true, details: { label } },
          ],
          continue: true,
        };
      };
      if (hard()) {
        const verdict = guard.beforeSettle(cfg().constitution.maxNudges);
        if (verdict && "stuck" in verdict) {
          this.emit({ kind: "stuck", label: verdict.stuck, suggest: cfg().escalation.model });
          return undefined;
        }
        if (verdict) return back(verdict.content, verdict.label);
      }
      if (hard() && todoTouched && !guard.finishedByUser && todoNudges < 2) {
        const n = todo.unfinishedNudge();
        if (n) {
          todoNudges++;
          return back(n.content, n.label);
        }
      }
      if (guard.finishedByUser && !stopNoted) {
        stopNoted = true;
        this.emit({ kind: "guard", label: t("Strażnicy wstrzymani — użytkownik kazał kończyć") });
      }
      if (cfg().review.enabled && !reviewed && !extraRound && !guard.finishedByUser && guard.changedFiles.length > 0) {
        reviewed = true;
        const result = await this.review(task, guard.changedFiles, guard.verified).catch((err: unknown) => {
          this.emit({ kind: "guard", label: `${t("Recenzja nie wyszła")}: ${err instanceof Error ? err.message : String(err)}` });
          return null;
        });
        if (result && !result.ok) {
          const n = result.issues.split("\n").filter((l) => l.trim()).length;
          extraRound = true;
          return back(reviewNudge(result.issues), plural(n, ["Recenzja: {n} uwaga — model poprawia", "Recenzja: {n} uwagi — model poprawia", "Recenzja: {n} uwag — model poprawia"], ["Review: {n} finding — the model is fixing it", "Review: {n} findings — the model is fixing them"]));
        }
        if (result && !result.skipped) this.emit({ kind: "guard", label: t("Recenzja: bez uwag") });
      }
      if (tasteOn()) {
        const tc = cfg().taste;
        const step = taste.beforeSettle({ requireAudit: tc.requireAudit, critic: tc.critic, maxRounds: tc.maxRounds, maxAuditNudges: cfg().constitution.maxNudges });
        if (taste.stoppedByUser && !stopNoted) {
          stopNoted = true;
          this.emit({ kind: "guard", label: t("Gust: wstrzymany — użytkownik przejął") });
        }
        if (step?.kind === "nudge") return back(step.nudge.content, step.nudge.label);
        if (step?.kind === "critic" && extraRound) {
          this.emit({ kind: "guard", label: t("Krytyk pominięty — w tej turze była już runda poprawek") });
        } else if (step?.kind === "critic") {
          const verdict = await this.critic(task, step.visual, step.target, taste.image).catch((err: unknown) => {
            this.emit({ kind: "guard", label: `${t("Krytyk nie wyszedł")}: ${err instanceof Error ? err.message : String(err)}` });
            return null;
          });
          if (verdict) {
            const { round } = taste.criticDone(verdict.ok);
            if (!verdict.ok) {
              const n = verdict.issues.split("\n").filter((l) => l.trim().startsWith("-")).length || 1;
              extraRound = true;
              return back(criticNudge(verdict.issues, round, tc.maxRounds), `${t("Krytyk (runda {round}/{max})", { round, max: tc.maxRounds })}: ${plural(n, ["{n} uwaga — model poprawia", "{n} uwagi — model poprawia", "{n} uwag — model poprawia"], ["{n} finding — the model is fixing it", "{n} findings — the model is fixing them"])}`);
            }
            this.emit({ kind: "guard", label: t("Krytyk: bez uwag") });
          }
        } else if (taste.exhausted(tc.maxRounds)) {
          this.emit({ kind: "guard", label: t("Krytyk: wykorzystano {n} rundy — ostatnich poprawek nikt nie ocenił", { n: tc.maxRounds }) });
        }
      }
      return undefined;
    });

    pi.on("context", (event) => {
      // Stale plan-mode instructions must not leak into later, non-plan turns.
      let messages =
        this.mode === "plan"
          ? event.messages
          : event.messages.filter((m) => (m as { customType?: string }).customType !== "pi-gui-plan-mode");
      const c = cfg().context;
      if (c.elideOldToolOutput) messages = elideOldToolOutput(messages, c.elideAboveChars);
      // Screenshots are heavy: within a run older ones become notes, a batch at a time.
      if (tasteOn()) messages = elideOldImages(messages, 3);
      // The plan goes near the end, where a small model's attention is: pinned, not stored.
      messages = recital.apply(messages, todo.recitation());
      return messages === event.messages ? undefined : { messages };
    });
  };

  /** "On-demand tools" section: stable text (only the policy changes it) so the prompt cache survives. */
  private toolCatalog(): string {
    const s = this.session;
    if (!s) return "";
    const deferred = s
      .getAllTools()
      .filter((t) => t.name !== ENABLE_TOOLS && this.config.toolPolicy(t.name) === "deferred")
      .map((t) => `- ${t.name}: ${firstSentence(t.description)}`);
    if (!deferred.length) return "";
    return (
      "## On-demand tools\nThese tools exist but are not loaded, to keep your context small. " +
      `If the task needs one, call ${ENABLE_TOOLS} with its name first.\n${deferred.join("\n")}`
    );
  }

  /** Tool policy or memory switch changed in the settings (GUI-wide): every live session follows. */
  policyChanged(tool?: { name: string; policy: string }): void {
    if (tool && tool.policy !== "deferred") this.onDemand.delete(tool.name);
    this.applyToolPolicy();
  }

  /** Active set = "always" tools + deferred ones the model loaded + the loader itself. */
  applyToolPolicy(): void {
    const s = this.session;
    if (!s) return;
    const names = s.getAllTools().map((t) => t.name);
    const policy = (n: string) => this.config.toolPolicy(n);
    const hasDeferred = names.some((n) => n !== ENABLE_TOOLS && policy(n) === "deferred");
    const active = names.filter((n) =>
      n === ENABLE_TOOLS
        ? hasDeferred
        : n === "remember"
          ? this.memoryActive()
          : policy(n) === "always" || (policy(n) === "deferred" && this.onDemand.has(n)),
    );
    s.setActiveToolsByName(active);
  }

  /** Fresh-context review of the run's changes by a tool-less session. */
  private async review(task: string, changed: string[], verified = false): Promise<ReviewVerdict> {
    const diff = this.runCheckpoint
      ? await diffSince(this.cwd, this.runCheckpoint)
      : changed
          .map((f) => {
            try {
              return `--- ${f} (full content after the change)\n${readFileSync(f, "utf8")}`;
            } catch {
              return `--- ${f} (deleted)`;
            }
          })
          .join("\n\n");
    if (!diff.trim()) return { ok: true, issues: "" };
    // A small change the model already proved with a passing check: a review costs more than it finds.
    const minLines = this.config.get().review.minLines;
    if (verified && this.runCheckpoint && changedLines(diff) < minLines) return { ok: true, issues: "", skipped: true };
    this.emit({ kind: "guard", label: t("Niezależna recenzja zmian…") });
    const services = this.env.services;
    const key = this.config.get().review.model;
    const model = key ? this.env.modelByKey(key) : this.session!.model!;
    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: services.agentDir,
      settingsManager: services.settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPrompt: "You are a meticulous senior code reviewer. You only see a task and a diff.",
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: this.cwd,
      model,
      modelRuntime: services.modelRuntime,
      settingsManager: services.settingsManager,
      sessionManager: SessionManager.inMemory(this.cwd),
      resourceLoader: loader,
      noTools: "all",
    });
    this.reviewer = session;
    try {
      await withRequestContext(this.ctx("reviewer"), () => session.prompt(reviewPrompt(task, diff)));
      const last = [...session.state.messages].reverse().find((m) => m.role === "assistant");
      const text =
        last && last.role === "assistant"
          ? last.content.map((c) => (c.type === "text" ? c.text : "")).join("")
          : "";
      return parseVerdict(text);
    } finally {
      this.reviewer = null;
      session.dispose();
    }
  }

  /**
   * Fresh-eyes visual review: same model as the session unless the user chose another,
   * new in-memory session with no tools, no history, no author reasoning. Sees the request,
   * reference | work side by side (+ phone width for pages) and the raw ui_audit numbers.
   */
  private async critic(task: string, kind: VisualKind, target: string | null, lastImage: { data: string; mimeType: string } | null): Promise<ReviewVerdict | null> {
    const cfg = this.config.get().taste;
    const key = cfg.criticModel;
    const model = key ? this.env.modelByKey(key) : this.session!.model!;
    const vision = (model as { input?: string[] }).input?.includes("image") ?? false;
    const ref = pickReference(this.cwd);
    const images: { type: "image"; data: string; mimeType: string }[] = [];
    let audit: string | undefined;
    let outline: string | undefined;
    const tmp = mkdtempSync(join(tmpdir(), "pi-gui-critic-"));
    this.emit({ kind: "guard", label: ref ? t("Krytyk: porównuje z wzorcem…") : t("Krytyk: ocenia wynik…") });
    try {
      if (kind === "ui") {
        if (!target) return null; // nothing to render — the audit nudge already asked for a target
        audit = formatAudit(await uiAudit({ target }, this.cwd));
        if (vision) {
          const main = ref ? await lookCompare({ a: ref, b: target }, this.cwd) : await look({ target, width: 1280, height: 800 }, this.cwd);
          const narrow = await look({ target, width: 390, height: 800 }, this.cwd);
          images.push({ type: "image", data: main.data, mimeType: main.mimeType }, { type: "image", data: narrow.data, mimeType: narrow.mimeType });
        } else {
          const url = /^https?:/i.test(target) ? target : `file://${target}`;
          outline = await withPage({ width: 1280, height: 800 }, async (page) => {
            await openPage(page, url);
            return pageOutline(page);
          });
        }
      } else {
        // 3D / illustration: the newest picture the model took of its own work.
        if (!vision || !lastImage) return null;
        const mine = join(tmp, "work.png");
        writeFileSync(mine, Buffer.from(lastImage.data, "base64"));
        const main = ref ? await lookCompare({ a: ref, b: mine, labels: ["REFERENCE", "WORK"] }, this.cwd) : await look({ target: mine }, this.cwd);
        images.push({ type: "image", data: main.data, mimeType: main.mimeType });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    const services = this.env.services;
    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: services.agentDir,
      settingsManager: services.settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPrompt: CRITIC_SYSTEM_PROMPT,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: this.cwd,
      model,
      modelRuntime: services.modelRuntime,
      settingsManager: services.settingsManager,
      sessionManager: SessionManager.inMemory(this.cwd),
      resourceLoader: loader,
      noTools: "all",
    });
    this.reviewer = session;
    try {
      const prompt = criticPrompt({ task, kind, hasReference: !!ref && vision, audit, outline });
      await withRequestContext(this.ctx("critic"), () =>
        withSlot(cfg.criticSlot, () => session.prompt(prompt, images.length ? { images } : undefined)),
      );
      const last = [...session.state.messages].reverse().find((m) => m.role === "assistant");
      const text = last && last.role === "assistant" ? last.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
      return parseVerdict(text);
    } finally {
      this.reviewer = null;
      session.dispose();
    }
  }

  /** Stuck run → a stronger model takes over the same session, then (optionally) hands back. */
  async escalate(key: string, reason: string): Promise<void> {
    const s = this.session;
    const previous = s.model;
    await s.setModel(this.env.modelByKey(key));
    await this.emitInit();
    try {
      await this.prompt(
        `The previous model got stuck on this task (${reason}). You are taking over. ` +
          "Re-read the relevant files, check the current state with a real check (tests, build, or running it), then finish the task and report how you verified it.",
      );
    } finally {
      if (this.config.get().escalation.revert && previous && this.session === s) {
        await s.setModel(previous);
        await this.emitInit();
      }
    }
  }

  async restoreCheckpoint(checkpoint: string): Promise<string[]> {
    if (this.busy) throw new Error(t("model pracuje — cofnij po zakończeniu"));
    const changes = await restore(this.cwd, checkpoint);
    return changes.map((c) => c.path);
  }

  /** Run's request timings → a custom entry keyed by the run's last assistant message. */
  private saveRunStats(session: AgentSession): void {
    const stats = this.runStats;
    this.runStats = [];
    if (!stats.length) return;
    const last = [...session.state.messages].reverse().find((m) => m.role === "assistant");
    if (!last) return;
    try {
      session.sessionManager.appendCustomEntry(STATS_ENTRY, { after: last.timestamp, stats } satisfies StatsEntryData);
    } catch {
      /* stats are a nicety — never fail a run over them */
    }
  }

  /** Session-only model switch (does not touch the global default — lesson 2). */
  async setModel(provider: string, modelId: string): Promise<void> {
    const s = this.session;
    const model = this.env.services.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`model not found: ${provider}/${modelId}`);
    await s.setModel(model);
    await this.emitInit();
    this.emitUsage();
  }

  // ── Memory ────────────────────────────────────────────────────────────────

  /** A pi extension that does memory on its own (e.g. ~/.pi/agent/extensions/memory.ts). */
  externalMemory(): string | null {
    const exts = this.session.resourceLoader.getExtensions().extensions ?? [];
    const hit = exts.find((e) => !e.hidden && /(^|\/)memory(\/index)?\.[cm]?[jt]s$/.test(e.resolvedPath));
    return hit?.resolvedPath ?? null;
  }

  /** Built-in memory is on and not doubled by an extension. */
  memoryActive(): boolean {
    return Boolean(this.env.memory && this.config.get().memory.enabled && !this.externalMemory());
  }

  async compact(instructions?: string): Promise<void> {
    const s = this.session;
    if (this.busy) throw new Error(t("model pracuje — kompaktowanie po zakończeniu"));
    await this.extensionsReady;
    await withRequestContext(this.ctx("compact"), () => s.compact(instructions?.trim() || undefined));
    this.emitUsage();
  }

  /**
   * Move the active branch back to before the Nth-from-last user message and
   * return its text for editing. The abandoned branch stays in the session tree.
   */
  async rewind(fromEnd: number): Promise<string> {
    const s = this.session;
    if (this.busy) throw new Error(t("model pracuje — zatrzymaj go przed cofaniem"));
    const users = s.sessionManager
      .getBranch()
      .filter((e) => e.type === "message" && (e as { message: { role: string } }).message.role === "user");
    const target = users[users.length - 1 - fromEnd];
    if (!target) throw new Error(t("nie znaleziono tej wiadomości w aktywnej gałęzi"));
    const res = await s.navigateTree(target.id, { summarize: false });
    if (res.cancelled) throw new Error(t("cofnięcie anulowane"));
    this.emitUsage();
    return res.editorText ?? "";
  }

  /** "/name" commands pi runs itself: extension commands, prompt templates, skills (same set as RPC get_commands). */
  commands(): SlashCommandInfo[] {
    const s = this.session;
    return [
      ...s.extensionRunner
        .getRegisteredCommands()
        .map((c): SlashCommandInfo => ({ name: c.invocationName, description: c.description ?? "", source: "extension" })),
      ...s.promptTemplates.map((t): SlashCommandInfo => ({ name: t.name, description: t.description, source: "prompt" })),
      ...s.resourceLoader
        .getSkills()
        .skills.map((k): SlashCommandInfo => ({ name: `skill:${k.name}`, description: k.description, source: "skill" })),
    ];
  }

  /** User messages of the active branch, newest first (what /fork offers). */
  forkPoints(): ForkPoint[] {
    return this.session
      .getUserMessagesForForking()
      .map((m) => ({ entryId: m.entryId, text: m.text }))
      .reverse();
  }

  stats(): SessionStats {
    const st = this.session.getSessionStats();
    return {
      sessionFile: st.sessionFile ?? "",
      userMessages: st.userMessages,
      assistantMessages: st.assistantMessages,
      toolCalls: st.toolCalls,
      tokens: st.tokens,
      cost: st.cost,
    };
  }

  /** HTML export (pi's /export): into the project directory, like pi run there. */
  async exportHtml(): Promise<string> {
    const s = this.session;
    const name = s.sessionFile ? `pi-session-${basename(s.sessionFile, ".jsonl")}.html` : "pi-session.html";
    return s.exportToHtml(join(this.cwd, name));
  }

  /** An extension was switched on or off: reload now, or once the running turn settles. */
  extensionsChanged(): void {
    if (this.busy) {
      this.reloadPending = true;
      return;
    }
    this.reloadPending = false;
    this.reload().catch((err: unknown) =>
      this.emit({ kind: "notice", level: "error", text: `${t("Przeładowanie rozszerzeń")}: ${err instanceof Error ? err.message : String(err)}` }),
    );
  }

  /** pi's /reload: extensions, skills, prompt templates, context files. */
  async reload(): Promise<void> {
    const s = this.session;
    if (this.busy) throw new Error(t("model pracuje — przeładowanie po zakończeniu"));
    await this.extensionsReady;
    await s.reload();
    this.applyToolPolicy();
    this.emitUsage();
  }

  async rename(name: string): Promise<void> {
    this.session.setSessionName(name);
    await this.emitInit();
  }

  /**
   * What every pi mode does after creating a session: give extensions a UI and
   * command actions, and fire session_start (MCP servers, pi-lens etc. start there).
   */
  private async bindExtensions(): Promise<void> {
    const session = this.session;
    const current = () => {
      if (this.disposed) throw new Error(t("sesja została już zamieniona"));
      return session;
    };
    // Session swaps started by an extension: the UI must reload the transcript itself.
    const swapped = async (withSession?: (ctx: ReturnType<AgentSession["createReplacedSessionContext"]>) => Promise<void>) => {
      this.env.emitGlobal({ kind: "session_changed" });
      const now = this.env.activeHost();
      if (withSession && now) await withSession(now.session.createReplacedSessionContext());
      return { cancelled: false };
    };
    const theme = (session.extensionRunner as unknown as { uiContext?: { theme?: unknown } }).uiContext?.theme;
    await session.bindExtensions({
      uiContext: this.dialogs.context(theme),
      mode: "rpc",
      commandContextActions: {
        waitForIdle: () => current().waitForIdle(),
        newSession: async (options) => {
          const sm = createSession(this.cwd);
          if (options?.parentSession) sm.newSession({ parentSession: options.parentSession });
          await options?.setup?.(sm);
          await this.env.startSession(this.cwd, sm);
          return swapped(options?.withSession);
        },
        fork: async (entryId, options) => {
          const s = current();
          const entry = s.sessionManager.getEntry(entryId) as { parentId: string | null } | undefined;
          if (!entry) throw new Error("Invalid entry ID for forking");
          await this.env.branchInto(this, options?.position === "at" ? entryId : entry.parentId);
          return swapped(options?.withSession);
        },
        navigateTree: async (targetId, options) => {
          const res = await current().navigateTree(targetId, options);
          if (!res.cancelled) this.emit({ kind: "session_changed" });
          return { cancelled: res.cancelled };
        },
        switchSession: async (sessionPath, options) => {
          await this.env.openSession(sessionPath);
          return swapped(options?.withSession);
        },
        reload: async () => {
          await current().reload();
          this.applyToolPolicy();
        },
      },
      onError: (err) =>
        this.emit({ kind: "notice", level: "error", text: `${t("Rozszerzenie {name} ({event})", { name: extensionName(err.extensionPath), event: err.event })}: ${err.error}` }),
    });
  }

  async emitInit(): Promise<void> {
    const model = this.env.isRealModel(this.session.model) ? this.session.model : undefined;
    this.emit({
      kind: "init_done",
      cwd: this.cwd,
      model: model?.id ?? "",
      provider: model?.provider ?? "",
      sessionId: this.session.sessionId ?? "",
      sessionPath: this.session.sessionFile ?? "",
      sessionName: this.session.sessionName ?? "",
      branch: await gitBranch(this.cwd),
      mode: this.mode,
      user: userInfo().username,
    });
  }

  usage(): Usage | null {
    const s = this.session;
    if (!s) return null;
    const ctx = s.getContextUsage();
    const stats = s.getSessionStats();
    const tokens = ctx?.tokens ?? null;
    return {
      contextTokens: tokens,
      contextWindow: ctx?.contextWindow ?? s.model?.contextWindow ?? 0,
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      breakdown: tokens === null ? undefined : this.breakdown(tokens),
    };
  }

  /** Same chars/4 heuristic pi uses; tools = the active schemas as sent to the model. */
  private breakdown(total: number): Usage["breakdown"] {
    const s = this.session;
    const system = Math.ceil(s.systemPrompt.length / 4);
    const active = new Set(s.getActiveToolNames());
    const defs = s
      .getAllTools()
      .filter((t) => active.has(t.name))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    const tools = Math.ceil(JSON.stringify(defs).length / 4);
    return { system, tools, messages: Math.max(0, total - system - tools) };
  }

  emitUsage(): void {
    const u = this.usage();
    if (u) this.emit({ kind: "usage", usage: u });
  }

  async prompt(text: string, images?: Attachment[], behavior?: "steer" | "followUp"): Promise<void> {
    const s = this.session;
    const imgs = images?.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }));
    if (this.starting) {
      this.early.push({ text, images });
      this.emit({ kind: "queue", steering: 0, followUp: this.early.length });
      return;
    }
    this.answerFirst.userMessage(text, this.busy);
    if (this.busy) {
      // The user is steering: the taste loop stops pushing its own agenda.
      this.taste?.userSpoke();
      if (finishIntent(text)) this.guard?.userFinish();
      // SDK rejects guessing while streaming: default to followUp (don't interrupt).
      if ((behavior ?? "followUp") === "steer") await s.steer(withMidrunNote(text), imgs);
      else await s.followUp(withMidrunNote(text), imgs);
      return;
    }
    this.running = true;
    this.starting = true;
    if (!s.state.messages.length) this.firstPrompt = text;
    this.busySince = Date.now();
    this.setStatus("working");
    // Learning shares the model server with this run (llama.cpp often has one slot) — the user wins.
    this.env.runStarting(this);
    const runs = this.settledRuns;
    try {
      await this.extensionsReady;
      this.runStats = [];
      await withRequestContext({ sessionId: s.sessionId, cwd: this.cwd, role: "main" }, () =>
        s.prompt(text, imgs?.length ? { images: imgs } : undefined),
      );
    } finally {
      this.running = false;
      this.starting = false;
      // An extension command may finish without an agent run — the UI still waits for "settled".
      if (this.settledRuns === runs && !s.state.isStreaming) this.emit({ kind: "settled" });
      // No run started (an extension command, an error): what waited becomes the next prompt.
      const [next, ...rest] = this.early.splice(0);
      if (next && !this.disposed) {
        void this.prompt(next.text, next.images)
          .catch((err: unknown) => this.emit({ kind: "notice", level: "error", text: err instanceof Error ? err.message : String(err) }));
        this.early.push(...rest);
      }
    }
  }

  /** The run is streaming: messages that arrived while it started are queued the normal way. */
  private flushEarly(): void {
    if (!this.starting) return;
    this.starting = false;
    for (const m of this.early.splice(0)) {
      const imgs = m.images?.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }));
      void this.session.followUp(m.text, imgs).catch((err: unknown) =>
        this.emit({ kind: "notice", level: "error", text: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  async abort(): Promise<void> {
    // Stop drops queued messages too (the UI shows them as not sent).
    this.early = [];
    // A run parked on an approval prompt can't observe abort — release it first.
    this.denyAllPending();
    this.dialogs.cancelAll();
    void this.reviewer?.abort();
    this.handoffAbort?.abort();
    if (this.busy) {
      this.answerFirst.interrupt();
      await this.session.abort();
    }
  }

  dispose(): void {
    this.denyAllPending();
    this.dialogs.cancelAll();
    this.disposed = true;
    this.session.dispose();
    this.running = false;
  }

  private subscribe(): void {
    const session = this.session;
    session.subscribe((event) => {
      // A disposed session may still flush events; drop them.
      if (this.disposed) return;
      switch (event.type) {
        case "message_update": {
          const a = event.assistantMessageEvent;
          if (a.type === "text_delta") this.emit({ kind: "text_delta", delta: a.delta });
          else if (a.type === "thinking_delta") this.emit({ kind: "thinking_delta", delta: a.delta });
          return;
        }
        case "message_end":
          this.emit({ kind: "message_end" });
          return;
        case "tool_execution_start":
          this.emit({
            kind: "tool_start",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          });
          return;
        case "tool_execution_update":
          this.emit({
            kind: "tool_update",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            partial: summarizeToolResult(event.partialResult),
          });
          return;
        case "tool_execution_end":
          this.emit({
            kind: "tool_end",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: withImages({ isError: event.isError, text: summarizeToolResult(event.result) }, event.result),
          });
          return;
        case "turn_start":
          this.emit({ kind: "turn_start" });
          this.flushEarly();
          return;
        case "turn_end":
          this.emit({ kind: "turn_end" });
          this.emitUsage();
          return;
        case "agent_end":
          this.emit({ kind: "agent_end" });
          return;
        case "agent_settled": {
          this.settledRuns++;
          this.emitUsage();
          this.saveRunStats(session);
          const cp = this.runCheckpoint;
          this.runCheckpoint = null;
          // Report restorable file changes before "settled" so the UI attaches them to this turn.
          const done = cp
            ? changesSince(this.cwd, cp)
                .then((files) => {
                  if (files.length) this.emit({ kind: "checkpoint", checkpoint: cp, files: files.map((f) => f.path) });
                })
                .catch(() => undefined)
            : Promise.resolve();
          void done.then(() => this.emit({ kind: "settled" }));
          return;
        }
        case "queue_update":
          this.emit({
            kind: "queue",
            steering: event.steering.length,
            followUp: event.followUp.length,
          });
          return;
        default:
          return;
      }
    });
  }
}

/**
 * Transcript as the UI renders it: blocks kept in model order, tool images as references.
 * `busy`: the session is mid-run — calls of its current turn without a result are still to come.
 */
export function historyOf(
sessionId: string,
messages: readonly AgentMessage[],
stats?: Map<number, RequestStats[]>,
running?: ReadonlySet<string>,
busy = false,
): HistoryItem[] {
  const items: HistoryItem[] = [];
  const toolIndex = new Map<string, Extract<HistoryPart, { type: "tool" }>>();
  /** Calls without a result yet, with the item they belong to. */
  const open = new Map<string, number>();
  for (const msg of messages) {
    if (msg.role === "user") {
      const images = userImages(msg.content);
      items.push(images.length ? { role: "user", text: userText(msg.content), images } : { role: "user", text: userText(msg.content) });
    } else if (msg.role === "assistant") {
      // Consecutive assistant messages (text → tool → text) form one visual turn.
      let last = items[items.length - 1];
      if (!last || last.role !== "assistant") {
        last = { role: "assistant", parts: [] };
        items.push(last);
      }
      for (const c of msg.content) {
        if (c.type === "thinking" && c.thinking.trim()) last.parts.push({ type: "thinking", text: c.thinking });
        else if (c.type === "text" && c.text.trim()) last.parts.push({ type: "text", text: c.text });
        else if (c.type === "toolCall") {
          const part: Extract<HistoryPart, { type: "tool" }> = {
            type: "tool",
            tool: { id: c.id, name: c.name, args: c.arguments, status: running?.has(c.id) ? "running" : "ok", summary: "" },
          };
          toolIndex.set(c.id, part);
          open.set(c.id, items.length - 1);
          last.parts.push(part);
        }
      }
      const saved = stats?.get(msg.timestamp);
      if (saved) last.stats = [...(last.stats ?? []), ...saved];
    } else if (msg.role === "custom" && msg.customType === CONSTITUTION_MESSAGE_TYPE) {
      const last = items[items.length - 1];
      const label = (msg.details as { label?: string } | undefined)?.label ?? t("Konstytucja");
      if (last?.role === "assistant") last.parts.push({ type: "notice", text: label });
    } else if (msg.role === "toolResult") {
      const part = toolIndex.get(msg.toolCallId);
      open.delete(msg.toolCallId);
      if (part) {
        part.tool.status = msg.isError ? "error" : "ok";
        part.tool.summary = summarizeToolResult({ content: msg.content });
        // Only references: the UI fetches each image when its thumbnail scrolls into view.
        const images = toolImages({ content: msg.content });
        if (images.length)
          part.tool.images = images.map((img, i) => ({ data: "", mimeType: img.mimeType, ref: `${sessionId}/${msg.toolCallId}/${i}` }));
      }
    }
  }
  // A call with no result never finished: the sidecar died or the run was cut while it waited
  // (for approval, say). Shown as ok it looked like an edit that happened — it did not.
  const lastUser = items.map((i) => i.role).lastIndexOf("user");
  for (const [id, at] of open) {
    const tool = toolIndex.get(id)!.tool;
    if (tool.status === "running" || (busy && at > lastUser)) {
      tool.status = "running";
      continue;
    }
    tool.status = "error";
    tool.summary = t("Przerwane — brak wyniku; narzędzie mogło się nie wykonać.");
  }
  return items;
}

/** Saved run timings by the timestamp of the assistant message they follow. */
export function statsEntries(sm: SessionManager): Map<number, RequestStats[]> {
  const out = new Map<number, RequestStats[]>();
  for (const e of sm.getEntries()) {
    if (e.type !== "custom" || e.customType !== STATS_ENTRY) continue;
    const d = e.data as StatsEntryData | undefined;
    if (d && typeof d.after === "number" && Array.isArray(d.stats)) out.set(d.after, [...(out.get(d.after) ?? []), ...d.stats]);
  }
  return out;
}

export async function gitBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 2000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

function userImages(content: string | { type: string; data?: string; mimeType?: string }[]): Attachment[] {
  if (typeof content === "string") return [];
  return content
    .filter((c) => c.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string")
    .map((c) => ({ data: c.data!, mimeType: c.mimeType! }));
}

export function userText(content: string | { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

/** Image blocks of a tool result, as the UI shows them. */
export function toolImages(result: unknown): Attachment[] {
  const content = (result as { content?: { type: string; data?: string; mimeType?: string }[] } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => c.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string")
    .map((c) => ({ data: c.data!, mimeType: c.mimeType! }));
}

function withImages<T extends object>(summary: T, result: unknown): T & { images?: Attachment[] } {
  const images = toolImages(result);
  return images.length ? { ...summary, images } : summary;
}

export function summarizeToolResult(result: unknown, max = TOOL_TEXT_MAX): string {
  const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content;
  if (!Array.isArray(content)) return typeof result === "string" ? result.slice(0, max) : "";
  const text = content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

/** "…/pi-lens/dist/index.js" → "pi-lens"; "…/extensions/memory.ts" → "memory". */
export function extensionName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const file = parts.pop() ?? path;
  if (!/^index\.[cm]?[jt]s$/.test(file)) return file.replace(/\.[cm]?[jt]s$/, "");
  while (parts.length && ["dist", "src", "lib", "build"].includes(parts[parts.length - 1])) parts.pop();
  return parts.pop() ?? file;
}
