import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  convertToLlm,
  createAgentSession,
  createAgentSessionServices,
  DefaultResourceLoader,
  initTheme,
  serializeConversation,
  SessionManager,
  type AgentSession,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  ApprovalDecision,
  Attachment,
  ForkPoint,
  HistoryItem,
  HistoryPart,
  ModelSummary,
  PermissionMode,
  PiEvent,
  PiSettings,
  SettingsPatch,
  SessionStats,
  SessionSummary,
  SlashCommandInfo,
  Usage,
} from "../../shared/protocol.js";
import { ExtensionDialogs } from "./extension-ui.js";
import { SidebarStore } from "./sidebar-store.js";
import { decide, PLAN_PROMPT } from "./permissions.js";
import { CONSTITUTION_MESSAGE_TYPE, ConstitutionGuard, DEFAULT_CONSTITUTION } from "./constitution.js";
import { GuiConfigStore } from "./config.js";
import { changesSince, diffSince, restore, snapshot } from "./checkpoint.js";
import { elideOldToolOutput } from "./elide.js";
import { HANDOFF_SYSTEM_PROMPT, handoffMessages, handoffUserText } from "./handoff.js";
import { parseVerdict, reviewNudge, reviewPrompt, type ReviewVerdict } from "./review.js";
import { installFetchTap, onPerf, setSampling, withSlot } from "./perf.js";
import { look, LOOK_COMPARE_DESCRIPTION, LOOK_DESCRIPTION, lookCompare } from "./look.js";
import { AUDIT_DESCRIPTION, countBySeverity, formatAudit, uiAudit } from "./audit.js";
import { designRefs, DESIGN_REFS_DESCRIPTION, hasRefs, refsRoot, topicSlug } from "./refs.js";
import { TasteGuard, type VisualKind } from "./taste.js";
import { CRITIC_SYSTEM_PROMPT, criticNudge, criticPrompt, pageOutline, pickReference } from "./critic.js";
import { open as openPage, withPage } from "./browser.js";
import { elideOldImages } from "./elide.js";

const run = promisify(execFile);

/** Tool output kept for the UI (bash logs can be long; the card scrolls). */
const TOOL_TEXT_MAX = 8000;

type AgentMessage = AgentSession["state"]["messages"][number];
const SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));

/** Meta-tool that loads deferred tools. */
const ENABLE_TOOLS = "enable_tools";

function firstSentence(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const m = /^(.{20,160}?[.!?])(\s|$)/.exec(line);
  return m ? m[1] : line.slice(0, 140);
}

/**
 * Thin wrapper around a pi AgentSession: one command surface in,
 * normalized PiEvent stream out.
 */
export class PiGateway {
  private session: AgentSession | null = null;
  /** True from prompt() call until it resolves — covers the gap before isStreaming flips. */
  private running = false;

  get ready(): boolean {
    return this.session !== null;
  }

  get busy(): boolean {
    return this.running || (this.session?.state.isStreaming ?? false);
  }

  private cwd = process.cwd();
  private services: Awaited<ReturnType<typeof createAgentSessionServices>> | null = null;

  /** Permission mode — GUI-wide, survives session switches like Claude Code's. */
  private mode: PermissionMode = "ask";
  /** Tool names the user approved "always" for the current session. */
  private alwaysAllowed = new Set<string>();
  private pendingApprovals = new Map<string, (d: { decision: ApprovalDecision; reason?: string }) => void>();
  private emit: (e: PiEvent) => void = () => undefined;
  private config: GuiConfigStore | null = null;
  /** Deferred tools the model loaded in this session. */
  private onDemand = new Set<string>();
  /** Worktree snapshot taken when the current run started (git projects only). */
  private runCheckpoint: string | null = null;
  private reviewer: AgentSession | null = null;
  private handoffAbort: AbortController | null = null;
  /** Extensions' session_start (MCP connects etc.) runs after the session is shown; a prompt waits for it. */
  private extensionsReady: Promise<void> = Promise.resolve();
  /** ctx.ui dialogs of pi extensions, answered in the GUI. */
  private dialogs = new ExtensionDialogs((e) => this.emit(e));
  /** Agent runs that reached agent_settled — tells prompt() whether a "/command" ran the agent at all. */
  private settledRuns = 0;

  /** The UI answered an extension dialog. */
  answerDialog(requestId: string, answer: Parameters<ExtensionDialogs["answer"]>[1]): void {
    this.dialogs.answer(requestId, answer);
  }

  get permissionMode(): PermissionMode {
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
    this.emit({ kind: "mode", mode });
  }

  /** Resolve a pending approval prompt from the UI. Unknown ids are ignored (already settled). */
  approve(toolCallId: string, decision: ApprovalDecision, reason?: string): void {
    const resolve = this.pendingApprovals.get(toolCallId);
    if (!resolve) return;
    this.pendingApprovals.delete(toolCallId);
    resolve({ decision, reason });
  }

  private denyAllPending(): void {
    for (const id of [...this.pendingApprovals.keys()]) this.approve(id, "deny", "run aborted");
  }

  /** pi `tool_call` hook: returns a block result or undefined (allowed). */
  async gate(toolCallId: string, toolName: string, input: Record<string, unknown>) {
    const verdict = decide(this.mode, toolName, input);
    if (verdict.kind === "allow") return undefined;
    if (verdict.kind === "block") return { block: true, reason: verdict.reason };
    if (this.alwaysAllowed.has(toolName)) return undefined;

    const answer = await new Promise<{ decision: ApprovalDecision; reason?: string }>((resolve) => {
      this.pendingApprovals.set(toolCallId, resolve);
      this.emit({ kind: "approval_request", toolCallId, toolName, args: input });
    });
    this.emit({ kind: "approval_done", toolCallId, decision: answer.decision });
    if (answer.decision === "always") this.alwaysAllowed.add(toolName);
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
    let task = "";
    let reviewed = false;
    const tasteOn = () => cfg().taste.enabled;
    /** Load deferred tools without the model asking (the taste guard needs design_refs etc.). */
    const loadTools = (names: string[]) => {
      const known = new Set(this.session?.getAllTools().map((t) => t.name));
      const ok = names.filter((n) => known.has(n) && this.config!.toolPolicy(n) !== "off");
      ok.forEach((n) => this.onDemand.add(n));
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...ok])]);
    };
    const cfg = () => this.config!.get();
    const hard = () => cfg().constitution.enabled && cfg().constitution.hard;

    // Deferred tools: listed by name in the system prompt, loaded on request.
    pi.registerTool({
      name: ENABLE_TOOLS,
      label: "Włącz narzędzia",
      description:
        "Load tools that are available on demand (see 'On-demand tools' in the system prompt). " +
        "Their full definitions become usable from your next step.",
      parameters: Type.Object({
        names: Type.Array(Type.String(), { description: "Tool names to load" }),
      }),
      execute: async (_id, params) => {
        const known = new Set(this.session?.getAllTools().map((t) => t.name));
        const ok = params.names.filter((n) => known.has(n) && this.config!.toolPolicy(n) !== "off");
        const bad = params.names.filter((n) => !ok.includes(n));
        ok.forEach((n) => this.onDemand.add(n));
        pi.setActiveTools([...new Set([...pi.getActiveTools(), ...ok])]);
        const text =
          (ok.length ? `Loaded: ${ok.join(", ")}. Use them from your next step.` : "Nothing loaded.") +
          (bad.length ? ` Unknown or disabled: ${bad.join(", ")}.` : "");
        return { content: [{ type: "text", text }], details: undefined };
      },
    });

    pi.on("tool_call", async (event, ctx) => {
      const input = event.input as Record<string, unknown>;
      // Constitution first: no point asking the user to approve a call that gets blocked anyway.
      const reason = hard() ? guard.beforeTool(event.toolName, input) : null;
      if (reason) return { block: true, reason };
      if (tasteOn() && this.mode !== "plan") {
        let research = cfg().taste.research;
        if (research === "ask" && taste.beforeTool(event.toolName, input, "auto") !== null) {
          // beforeTool counted a block; the user decides whether it stands.
          const choice = await ctx.ui.select("Poszukać wzorców przed pracą wizualną?", ["Tak", "Nie, tym razem", "Zawsze szukaj", "Nigdy nie szukaj"]);
          if (choice === "Zawsze szukaj") this.config!.update("taste", { research: "auto" });
          if (choice === "Nigdy nie szukaj") this.config!.update("taste", { research: "off" });
          if (choice === "Tak" || choice === "Zawsze szukaj") {
            loadTools(["design_refs"]);
            return { block: true, reason: "Taste: the user wants references first. Call design_refs (kind and a specific query), write brief.md, then build." };
          }
          taste.markResearched();
          research = "off";
        }
        const tasteReason = research === "auto" ? taste.beforeTool(event.toolName, input, research) : null;
        if (tasteReason) {
          loadTools(["design_refs"]);
          this.emit({ kind: "guard", label: "Gust: najpierw wzorce, potem budowanie" });
          return { block: true, reason: tasteReason };
        }
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
    });

    pi.registerTool({
      name: "look",
      label: "Podgląd",
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
      label: "Porównanie",
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
      label: "Audyt UI",
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
      label: "Wzorce",
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

    pi.on("before_agent_start", async (event) => {
      guard.startRun();
      taste.startRun();
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
      this.runCheckpoint = await snapshot(this.cwd, task.slice(0, 60)).catch(() => null);
      const extra = [
        cfg().constitution.enabled ? this.config!.constitutionText : "",
        this.toolCatalog(),
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
      if (cfg().review.enabled && !reviewed && guard.changedFiles.length > 0) {
        reviewed = true;
        const result = await this.review(task, guard.changedFiles).catch((err: unknown) => {
          this.emit({ kind: "guard", label: `Recenzja nie wyszła: ${err instanceof Error ? err.message : String(err)}` });
          return null;
        });
        if (result && !result.ok) {
          const n = result.issues.split("\n").filter((l) => l.trim()).length;
          return back(reviewNudge(result.issues), `Recenzja: ${n} ${n === 1 ? "uwaga" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "uwagi" : "uwag"} — model poprawia`);
        }
        if (result) this.emit({ kind: "guard", label: "Recenzja: bez uwag" });
      }
      if (tasteOn()) {
        const t = cfg().taste;
        const step = taste.beforeSettle({ requireAudit: t.requireAudit, critic: t.critic, maxRounds: t.maxRounds, maxAuditNudges: cfg().constitution.maxNudges });
        if (step?.kind === "nudge") return back(step.nudge.content, step.nudge.label);
        if (step?.kind === "critic") {
          const verdict = await this.critic(task, step.visual, step.target, taste.image).catch((err: unknown) => {
            this.emit({ kind: "guard", label: `Krytyk nie wyszedł: ${err instanceof Error ? err.message : String(err)}` });
            return null;
          });
          if (verdict) {
            const { round } = taste.criticDone(verdict.ok);
            if (!verdict.ok) {
              const n = verdict.issues.split("\n").filter((l) => l.trim().startsWith("-")).length || 1;
              return back(criticNudge(verdict.issues, round, t.maxRounds), `Krytyk (runda ${round}/${t.maxRounds}): ${n} ${n === 1 ? "uwaga" : n < 5 ? "uwagi" : "uwag"} — model poprawia`);
            }
            this.emit({ kind: "guard", label: "Krytyk: bez uwag" });
          }
        } else if (taste.exhausted(t.maxRounds)) {
          this.emit({ kind: "guard", label: `Krytyk: wykorzystano ${t.maxRounds} rundy — ostatnich poprawek nikt nie ocenił` });
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
      // Screenshots are heavy: within a run only the newest few stay as pictures.
      if (tasteOn()) messages = elideOldImages(messages, 3);
      return messages === event.messages ? undefined : { messages };
    });
  };

  /** "On-demand tools" section: stable text (only the policy changes it) so the prompt cache survives. */
  private toolCatalog(): string {
    const s = this.session;
    if (!s) return "";
    const deferred = s
      .getAllTools()
      .filter((t) => t.name !== ENABLE_TOOLS && this.config!.toolPolicy(t.name) === "deferred")
      .map((t) => `- ${t.name}: ${firstSentence(t.description)}`);
    if (!deferred.length) return "";
    return (
      "## On-demand tools\nThese tools exist but are not loaded, to keep your context small. " +
      `If the task needs one, call ${ENABLE_TOOLS} with its name first.\n${deferred.join("\n")}`
    );
  }

  /** Active set = "always" tools + deferred ones the model loaded + the loader itself. */
  private applyToolPolicy(): void {
    const s = this.session;
    if (!s) return;
    const names = s.getAllTools().map((t) => t.name);
    const policy = (n: string) => this.config!.toolPolicy(n);
    const hasDeferred = names.some((n) => n !== ENABLE_TOOLS && policy(n) === "deferred");
    const active = names.filter((n) =>
      n === ENABLE_TOOLS ? hasDeferred : policy(n) === "always" || (policy(n) === "deferred" && this.onDemand.has(n)),
    );
    s.setActiveToolsByName(active);
  }

  /** Fresh-context review of the run's changes by a tool-less session. */
  private async review(task: string, changed: string[]): Promise<ReviewVerdict> {
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
    this.emit({ kind: "guard", label: "Niezależna recenzja zmian…" });
    const services = this.requireServices();
    const key = this.config!.get().review.model;
    const model = key ? this.modelByKey(key) : this.session!.model!;
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
      await session.prompt(reviewPrompt(task, diff));
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
    const cfg = this.config!.get().taste;
    const key = cfg.criticModel;
    const model = key ? this.modelByKey(key) : this.session!.model!;
    const vision = (model as { input?: string[] }).input?.includes("image") ?? false;
    const ref = pickReference(this.cwd);
    const images: { type: "image"; data: string; mimeType: string }[] = [];
    let audit: string | undefined;
    let outline: string | undefined;
    const tmp = mkdtempSync(join(tmpdir(), "pi-gui-critic-"));
    this.emit({ kind: "guard", label: ref ? "Krytyk: porównuje z wzorcem…" : "Krytyk: ocenia wynik…" });
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
    const services = this.requireServices();
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
      await withSlot(cfg.criticSlot, () => session.prompt(prompt, images.length ? { images } : undefined));
      const last = [...session.state.messages].reverse().find((m) => m.role === "assistant");
      const text = last && last.role === "assistant" ? last.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
      return parseVerdict(text);
    } finally {
      this.reviewer = null;
      session.dispose();
    }
  }

  private modelByKey(key: string) {
    const slash = key.indexOf("/");
    const model = this.requireServices().modelRuntime.getModel(key.slice(0, slash), key.slice(slash + 1));
    if (!model) throw new Error(`model not found: ${key}`);
    return model;
  }

  /** Stuck run → a stronger model takes over the same session, then (optionally) hands back. */
  async escalate(key: string, reason: string): Promise<void> {
    const s = this.requireSession();
    const previous = s.model;
    await s.setModel(this.modelByKey(key));
    await this.emitInit(this.emit);
    try {
      await this.prompt(
        `The previous model got stuck on this task (${reason}). You are taking over. ` +
          "Re-read the relevant files, check the current state with a real check (tests, build, or running it), then finish the task and report how you verified it.",
      );
    } finally {
      if (this.config!.get().escalation.revert && previous && this.session === s) {
        await s.setModel(previous);
        await this.emitInit(this.emit);
      }
    }
  }

  async restoreCheckpoint(checkpoint: string): Promise<string[]> {
    if (this.busy) throw new Error("model pracuje — cofnij po zakończeniu");
    const changes = await restore(this.cwd, checkpoint);
    return changes.map((c) => c.path);
  }

  async init(onEvent: (e: PiEvent) => void, cwd?: string): Promise<void> {
    // Idempotent: a re-init (e.g. a second UI client) re-emits init_done
    // so the caller can always learn the current model/cwd.
    if (this.session) {
      await this.emitInit(onEvent);
      return;
    }
    const workingDir = cwd ?? process.cwd();
    this.cwd = workingDir;
    this.emit = onEvent;
    installFetchTap();
    onPerf((perf) => this.emit({ kind: "perf", perf }));
    this.services = await createAgentSessionServices({ cwd: workingDir });
    // pi's main() does this for every mode; extensions with a UI format text with the theme.
    initTheme(this.services.settingsManager.getTheme(), false);
    // PI_GUI_CONFIG lets the eval harness run profiles without touching the user's file.
    this.config = new GuiConfigStore(process.env.PI_GUI_CONFIG ?? `${this.services.agentDir}/pi-gui.json`);
    setSampling(this.config.get().sampling);
    // PI_GUI_EPHEMERAL (eval harness): keep throwaway runs out of the user's session history.
    const sm = process.env.PI_GUI_EPHEMERAL ? SessionManager.inMemory(workingDir) : SessionManager.create(workingDir);
    await this.startSession(onEvent, workingDir, sm);
  }

  /** Rendered transcript of the active session, blocks kept in model order. */
  history(): HistoryItem[] {
    const s = this.requireSession();
    return this.historyOf(s.sessionId, s.state.messages);
  }

  /** Messages last rendered by historyOf — historyImage looks images up here. */
  private shown: { sessionId: string; messages: readonly AgentMessage[] } | null = null;

  private historyOf(sessionId: string, messages: readonly AgentMessage[]): HistoryItem[] {
    this.shown = { sessionId, messages };
    const items: HistoryItem[] = [];
    const toolIndex = new Map<string, Extract<HistoryPart, { type: "tool" }>>();
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
              tool: { id: c.id, name: c.name, args: c.arguments, status: "ok", summary: "" },
            };
            toolIndex.set(c.id, part);
            last.parts.push(part);
          }
        }
      } else if (msg.role === "custom" && msg.customType === CONSTITUTION_MESSAGE_TYPE) {
        const last = items[items.length - 1];
        const label = (msg.details as { label?: string } | undefined)?.label ?? "Konstytucja";
        if (last?.role === "assistant") last.parts.push({ type: "notice", text: label });
      } else if (msg.role === "toolResult") {
        const part = toolIndex.get(msg.toolCallId);
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
    return items;
  }

  /** An image history() left out; ref = sessionId/toolCallId/index. */
  historyImage(ref: string): Attachment {
    const [sessionId, toolCallId, index] = ref.split("/");
    // The transcript on screen may be an early preview of a session still starting (openSession).
    const messages = this.shown?.sessionId === sessionId ? this.shown.messages : this.session?.sessionId === sessionId ? this.session.state.messages : null;
    if (!messages) throw new Error("obraz z innej sesji");
    const msg = messages.find((m) => m.role === "toolResult" && m.toolCallId === toolCallId);
    const img = msg?.role === "toolResult" ? toolImages({ content: msg.content })[Number(index)] : undefined;
    if (!img) throw new Error("nie ma takiego obrazu");
    return { ...img, ref };
  }

  private sidebarStore: SidebarStore | null = null;
  /** Swappable in tests: gio refuses to trash files on tmpfs. */
  trashFile: (file: string) => Promise<void> = trash;

  /** Groups and added projects; PI_GUI_SIDEBAR lets tests use a throwaway file. */
  get sidebar(): SidebarStore {
    this.sidebarStore ??= new SidebarStore(process.env.PI_GUI_SIDEBAR ?? join(this.requireServices().agentDir, "pi-gui-sidebar.json"));
    return this.sidebarStore;
  }

  /**
   * Move a session file to the system trash (recoverable). Deleting the open session
   * stops its run and starts a fresh one in the same project.
   */
  async deleteSession(onEvent: (e: PiEvent) => void, path: string): Promise<{ path: string; active: boolean }> {
    const root = resolve(this.requireServices().agentDir, "sessions");
    const file = resolve(path);
    if (!file.startsWith(root + sep) || !file.endsWith(".jsonl")) throw new Error("to nie jest plik sesji pi");
    const active = !!this.session?.sessionFile && resolve(this.session.sessionFile) === file;
    if (active) {
      await this.abort();
      await this.extensionsReady;
    }
    if (existsSync(file)) await this.trashFile(file);
    this.sidebar.forget(path);
    if (active) await this.newSession(onEvent, this.cwd);
    return { path, active };
  }

  async listSessions(): Promise<SessionSummary[]> {
    // All sessions across all project dirs (sidebar is global, like Claude desktop).
    const infos = await SessionManager.listAll();
    return infos
      .map((s) => ({
        path: s.path,
        id: s.id,
        cwd: s.cwd,
        name: s.name,
        modified: s.modified.toISOString(),
        messageCount: s.messageCount,
        firstMessage: s.firstMessage,
      }))
      .sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async listModels(): Promise<ModelSummary[]> {
    const services = this.requireServices();
    const models = await services.modelRuntime.getAvailable();
    return models.map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name ?? m.id,
      contextWindow: m.contextWindow ?? 0,
      vision: m.input?.includes("image") ?? false,
    }));
  }

  /** Session-only model switch (does not touch the global default — lesson 2). */
  async setModel(onEvent: (e: PiEvent) => void, provider: string, modelId: string): Promise<void> {
    const s = this.requireSession();
    const model = this.requireServices().modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`model not found: ${provider}/${modelId}`);
    await s.setModel(model);
    await this.emitInit(onEvent);
    this.emitUsage(onEvent);
  }

  /** Snapshot for the settings dialog: pi's global settings + what this session loaded. */
  settings(): PiSettings {
    const s = this.requireSession();
    const services = this.requireServices();
    const sm = services.settingsManager;
    const compaction = sm.getCompactionSettings();
    const retry = sm.getRetrySettings();
    const active = new Set(s.getActiveToolNames());
    const loader = s.resourceLoader;
    const src = (i: { source: string; scope: string }) => {
      if (i.source === "builtin") return "wbudowane";
      if (i.source === "auto") return "lokalne";
      const name = i.source.replace(/^npm:/, "");
      return i.scope === "project" ? `projekt · ${name}` : name;
    };
    return {
      settingsFile: `${services.agentDir}/settings.json`,
      defaultModel: `${sm.getDefaultProvider() ?? "?"}/${sm.getDefaultModel() ?? "?"}`,
      thinking: {
        level: s.thinkingLevel,
        available: s.supportsThinking() ? s.getAvailableThinkingLevels() : [],
        defaultLevel: sm.getDefaultThinkingLevel() ?? "",
      },
      steeringMode: sm.getSteeringMode(),
      followUpMode: sm.getFollowUpMode(),
      compaction,
      retry: { enabled: retry.enabled, maxRetries: retry.maxRetries, baseDelayMs: retry.baseDelayMs },
      images: { autoResize: sm.getImageAutoResize(), blockImages: sm.getBlockImages() },
      shellPath: sm.getShellPath() ?? "",
      shellCommandPrefix: sm.getShellCommandPrefix() ?? "",
      tools: s
        .getAllTools()
        .filter((t) => t.name !== ENABLE_TOOLS)
        .map((t) => ({
          name: t.name,
          description: t.description,
          active: active.has(t.name),
          source: src(t.sourceInfo),
          tokens: Math.ceil(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length / 4),
          policy: this.config!.toolPolicy(t.name),
        })),
      extensions: loader
        .getExtensions()
        .extensions.filter((e) => !e.hidden)
        .map((e) => ({ name: extensionName(e.resolvedPath), path: e.resolvedPath, source: src(e.sourceInfo) })),
      skills: loader.getSkills().skills.map((k) => ({ name: k.name, description: k.description, source: src(k.sourceInfo) })),
      contextFiles: loader.getAgentsFiles().agentsFiles.map((f) => f.path),
      constitution: {
        ...this.config!.get().constitution,
        defaultText: DEFAULT_CONSTITUTION,
        file: this.config!.path,
      },
      gui: this.config!.get(),
      contextWindow: s.model?.contextWindow ?? 0,
      compactAt: s.model ? (s.model.contextWindow ?? 0) - sm.getCompactionReserveTokens(s.model) : 0,
      modelVision: s.model?.input?.includes("image") ?? false,
    };
  }

  async updateSettings(onEvent: (e: PiEvent) => void, patch: SettingsPatch): Promise<PiSettings> {
    const s = this.requireSession();
    const sm = this.requireServices().settingsManager;
    if (patch.thinkingLevel !== undefined) s.setThinkingLevel(patch.thinkingLevel as Parameters<AgentSession["setThinkingLevel"]>[0]);
    if (patch.defaultThinkingLevel !== undefined) sm.setDefaultThinkingLevel(patch.defaultThinkingLevel as Parameters<AgentSession["setThinkingLevel"]>[0]);
    if (patch.defaultModel !== undefined) {
      const slash = patch.defaultModel.indexOf("/");
      sm.setDefaultModelAndProvider(patch.defaultModel.slice(0, slash), patch.defaultModel.slice(slash + 1));
    }
    if (patch.steeringMode) sm.setSteeringMode(patch.steeringMode);
    if (patch.followUpMode) sm.setFollowUpMode(patch.followUpMode);
    if (patch.compactionEnabled !== undefined) sm.setCompactionEnabled(patch.compactionEnabled);
    if (patch.reserveTokens !== undefined) setNested(sm, "compaction", "reserveTokens", patch.reserveTokens);
    if (patch.keepRecentTokens !== undefined) setNested(sm, "compaction", "keepRecentTokens", patch.keepRecentTokens);
    if (patch.retryEnabled !== undefined) sm.setRetryEnabled(patch.retryEnabled);
    if (patch.maxRetries !== undefined) setNested(sm, "retry", "maxRetries", patch.maxRetries);
    if (patch.baseDelayMs !== undefined) setNested(sm, "retry", "baseDelayMs", patch.baseDelayMs);
    if (patch.imageAutoResize !== undefined) sm.setImageAutoResize(patch.imageAutoResize);
    if (patch.blockImages !== undefined) sm.setBlockImages(patch.blockImages);
    if (patch.shellPath !== undefined) sm.setShellPath(patch.shellPath || undefined);
    if (patch.shellCommandPrefix !== undefined) sm.setShellCommandPrefix(patch.shellCommandPrefix || undefined);
    const config = this.config!;
    if (patch.constitution) config.update("constitution", patch.constitution);
    if (patch.context) config.update("context", patch.context);
    if (patch.review) config.update("review", patch.review);
    if (patch.escalation) config.update("escalation", patch.escalation);
    if (patch.taste) config.update("taste", patch.taste);
    if (patch.sampling) {
      config.update("sampling", patch.sampling);
      setSampling(config.get().sampling);
    }
    if (patch.toolPolicy) {
      config.setToolPolicy(patch.toolPolicy.name, patch.toolPolicy.policy);
      if (patch.toolPolicy.policy !== "deferred") this.onDemand.delete(patch.toolPolicy.name);
      this.applyToolPolicy();
      this.emitUsage(onEvent); // tool schemas are part of the context
    }
    if (patch.compactAt !== undefined && s.model) {
      const window = s.model.contextWindow ?? 0;
      setCompactionOverride(sm, `${s.model.provider}/${s.model.id}`, patch.compactAt > 0 ? window - patch.compactAt : undefined);
    }
    await sm.flush();
    const errors = sm.drainErrors();
    if (errors.length) throw new Error(`zapis ustawień: ${errors.map((e) => String(e.error ?? e)).join("; ")}`);
    return this.settings();
  }

  async compact(onEvent: (e: PiEvent) => void, instructions?: string): Promise<void> {
    const s = this.requireSession();
    if (this.busy) throw new Error("model pracuje — kompaktowanie po zakończeniu");
    await this.extensionsReady;
    await s.compact(instructions?.trim() || undefined);
    this.emitUsage(onEvent);
  }

  get workingDir(): string {
    return this.cwd;
  }

  /** Base URL of the active model's provider (llama-server router), if it has one. */
  get baseUrl(): string | undefined {
    return (this.session?.model as { baseUrl?: string } | undefined)?.baseUrl;
  }

  /**
   * Move the active branch back to before the Nth-from-last user message and
   * return its text for editing. The abandoned branch stays in the session tree.
   */
  async rewind(onEvent: (e: PiEvent) => void, fromEnd: number): Promise<string> {
    const s = this.requireSession();
    if (this.busy) throw new Error("model pracuje — zatrzymaj go przed cofaniem");
    const users = s.sessionManager
      .getBranch()
      .filter((e) => e.type === "message" && (e as { message: { role: string } }).message.role === "user");
    const target = users[users.length - 1 - fromEnd];
    if (!target) throw new Error("nie znaleziono tej wiadomości w aktywnej gałęzi");
    const res = await s.navigateTree(target.id, { summarize: false });
    if (res.cancelled) throw new Error("cofnięcie anulowane");
    this.emitUsage(onEvent);
    return res.editorText ?? "";
  }

  /** "/name" commands pi runs itself: extension commands, prompt templates, skills (same set as RPC get_commands). */
  commands(): SlashCommandInfo[] {
    const s = this.requireSession();
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
    return this.requireSession()
      .getUserMessagesForForking()
      .map((m) => ({ entryId: m.entryId, text: m.text }))
      .reverse();
  }

  /**
   * New session with the branch up to (not including) that user message — pi's /fork.
   * Returns the message text so the UI can put it back in the composer.
   */
  async fork(onEvent: (e: PiEvent) => void, entryId: string): Promise<string> {
    const s = this.requireSession();
    if (this.busy) throw new Error("model pracuje — fork po zakończeniu");
    const entry = s.sessionManager.getEntry(entryId) as
      | { type: string; parentId: string | null; message?: { role: string; content: Parameters<typeof userText>[0] } }
      | undefined;
    if (!entry || entry.type !== "message" || entry.message?.role !== "user") throw new Error("nie ma takiej wiadomości w sesji");
    const text = userText(entry.message.content);
    await this.branchInto(onEvent, entry.parentId);
    return text;
  }

  /** New session with a copy of the active branch — pi's /clone. */
  async clone(onEvent: (e: PiEvent) => void): Promise<void> {
    const s = this.requireSession();
    if (this.busy) throw new Error("model pracuje — kopia po zakończeniu");
    const leaf = s.sessionManager.getLeafId();
    if (!leaf) throw new Error("sesja jest pusta — nie ma czego kopiować");
    await this.branchInto(onEvent, leaf);
  }

  /**
   * pi-style /handoff: the current model writes a self-contained prompt from this
   * branch, then a fresh session (child of this one) starts in the same cwd.
   * The prompt is returned, not sent — the UI puts it in the composer.
   */
  async handoff(onEvent: (e: PiEvent) => void, goal: string): Promise<{ prompt: string; from: string }> {
    const s = this.requireSession();
    if (this.busy || this.handoffAbort) throw new Error("model pracuje — handoff po zakończeniu");
    if (!s.model) throw new Error("brak modelu");
    const messages = handoffMessages(s.sessionManager.getBranch() as never);
    if (!messages.length) throw new Error("sesja jest pusta — nie ma czego przekazać");
    const conversation = serializeConversation(convertToLlm(messages as never));
    // Same title the sidebar shows: the name, else the first user message.
    const first = messages.find((m) => (m as { role?: string }).role === "user") as { content: Parameters<typeof userText>[0] } | undefined;
    const from = (s.sessionName || (first ? userText(first.content) : "")).replace(/\s+/g, " ").trim();
    const title = from.length > 60 ? `${from.slice(0, 59)}…` : from;
    const abort = (this.handoffAbort = new AbortController());
    let prompt: string;
    try {
      const res = await s.modelRuntime.complete(
        s.model,
        {
          systemPrompt: HANDOFF_SYSTEM_PROMPT,
          messages: [{ role: "user", content: [{ type: "text", text: handoffUserText(conversation, goal) }], timestamp: Date.now() }],
        },
        { signal: abort.signal, cacheRetention: "none", sessionId: randomUUID() },
      );
      if (res.stopReason === "aborted" || abort.signal.aborted) throw new Error("handoff przerwany");
      if (res.stopReason === "error") throw new Error(res.errorMessage || "model zwrócił błąd");
      prompt = res.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("\n")
        .trim();
    } finally {
      this.handoffAbort = null;
    }
    if (!prompt) throw new Error("model nie napisał handoffu");
    // Persisted parent → the new session keeps a link back (like pi's /handoff).
    const file = s.sessionManager.isPersisted() && s.sessionFile && existsSync(s.sessionFile) ? s.sessionFile : undefined;
    const sm = SessionManager.create(this.cwd, s.sessionManager.getSessionDir());
    if (file) sm.newSession({ parentSession: file });
    await this.startSession(onEvent, this.cwd, sm);
    return { prompt, from: title };
  }

  /** Same file handling as pi's runtime fork: a new session file holding root → leafId. */
  private async branchInto(onEvent: (e: PiEvent) => void, leafId: string | null): Promise<void> {
    const s = this.requireSession();
    if (!s.sessionManager.isPersisted()) throw new Error("sesja nie jest zapisywana na dysk");
    const file = s.sessionFile;
    const dir = s.sessionManager.getSessionDir();
    if (!leafId) {
      // Forking before the very first message: an empty session that remembers its parent.
      const sm = SessionManager.create(this.cwd, dir);
      sm.newSession({ parentSession: file });
      await this.startSession(onEvent, this.cwd, sm);
      return;
    }
    if (!file || !existsSync(file)) throw new Error("sesja nie jest jeszcze zapisana — poczekaj na pierwszą odpowiedź modelu");
    const sm = SessionManager.open(file, dir);
    if (!sm.createBranchedSession(leafId)) throw new Error("nie udało się utworzyć nowej sesji");
    await this.startSession(onEvent, sm.getCwd() || this.cwd, sm);
  }

  stats(): SessionStats {
    const st = this.requireSession().getSessionStats();
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
    const s = this.requireSession();
    const name = s.sessionFile ? `pi-session-${basename(s.sessionFile, ".jsonl")}.html` : "pi-session.html";
    return s.exportToHtml(join(this.cwd, name));
  }

  /** pi's /reload: extensions, skills, prompt templates, context files. */
  async reload(onEvent: (e: PiEvent) => void): Promise<void> {
    const s = this.requireSession();
    if (this.busy) throw new Error("model pracuje — przeładowanie po zakończeniu");
    await this.extensionsReady;
    await s.reload();
    this.applyToolPolicy();
    this.emitUsage(onEvent);
  }

  async rename(onEvent: (e: PiEvent) => void, name: string): Promise<void> {
    this.requireSession().setSessionName(name);
    await this.emitInit(onEvent);
  }

  /** Replace the active session with a persisted one (sidebar "open"). */
  async openSession(onEvent: (e: PiEvent) => void, path: string): Promise<void> {
    this.requireServices();
    const sessionManager = SessionManager.open(path);
    // Show the transcript straight from the file (~20 ms); the agent session with its
    // extensions takes up to ~0.5 s more when the project changes.
    onEvent({
      kind: "history",
      sessionPath: sessionManager.getSessionFile() ?? path,
      items: this.historyOf(sessionManager.getSessionId(), sessionManager.buildSessionContext().messages),
    });
    // Tools must run in the session's own project, not wherever the GUI started.
    const cwd = sessionManager.getCwd() || this.cwd;
    await this.startSession(onEvent, cwd, sessionManager);
  }

  /** Start a brand-new empty session (UI "Nowa sesja"). */
  async newSession(onEvent: (e: PiEvent) => void, cwd?: string): Promise<void> {
    this.requireServices();
    const target = cwd ?? this.cwd;
    await this.startSession(onEvent, target, SessionManager.create(target));
  }

  private async startSession(
    onEvent: (e: PiEvent) => void,
    cwd: string,
    sessionManager: SessionManager,
  ): Promise<void> {
    const services = this.requireServices();
    const model = this.session?.model ?? this.resolveDefaultModel();
    await this.extensionsReady; // never dispose a session its extensions are still starting on
    this.dispose();
    this.alwaysAllowed.clear(); // "always" is per session
    this.onDemand.clear();
    // One loader per session: project context files and extensions are cwd-bound,
    // and this is where the GUI's own inline extension (permission gate) is attached.
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: services.agentDir,
      settingsManager: services.settingsManager,
      extensionFactories: [{ name: "pi-gui", hidden: true, factory: this.extension }],
      // GUI-bundled skills (visual design rules etc.), loaded on demand like any pi skill.
      additionalSkillPaths: [SKILLS_DIR],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      model,
      modelRuntime: services.modelRuntime,
      settingsManager: services.settingsManager,
      sessionManager,
      resourceLoader,
    });
    this.cwd = cwd;
    this.session = session;
    this.applyToolPolicy();
    this.subscribe(session, onEvent);
    // Not awaited: switching sessions must not wait for extensions (~200 ms, more with MCP).
    this.extensionsReady = this.bindExtensions(session, onEvent).catch((err: unknown) =>
      onEvent({ kind: "notice", level: "error", text: `Start rozszerzeń: ${err instanceof Error ? err.message : String(err)}` }),
    );
    await this.emitInit(onEvent);
    this.emitUsage(onEvent);
  }

  /**
   * What every pi mode does after creating a session: give extensions a UI and
   * command actions, and fire session_start (MCP servers, pi-lens etc. start there).
   */
  private async bindExtensions(session: AgentSession, onEvent: (e: PiEvent) => void): Promise<void> {
    const current = () => {
      if (this.session !== session) throw new Error("sesja została już zamieniona");
      return session;
    };
    // Session swaps started by an extension: the UI must reload the transcript itself.
    const swapped = async (withSession?: (ctx: ReturnType<AgentSession["createReplacedSessionContext"]>) => Promise<void>) => {
      onEvent({ kind: "session_changed" });
      if (withSession && this.session) await withSession(this.session.createReplacedSessionContext());
      return { cancelled: false };
    };
    const theme = (session.extensionRunner as unknown as { uiContext?: { theme?: unknown } }).uiContext?.theme;
    await session.bindExtensions({
      uiContext: this.dialogs.context(theme),
      mode: "rpc",
      commandContextActions: {
        waitForIdle: () => current().waitForIdle(),
        newSession: async (options) => {
          const sm = SessionManager.create(this.cwd);
          if (options?.parentSession) sm.newSession({ parentSession: options.parentSession });
          await options?.setup?.(sm);
          await this.startSession(onEvent, this.cwd, sm);
          return swapped(options?.withSession);
        },
        fork: async (entryId, options) => {
          const s = current();
          const entry = s.sessionManager.getEntry(entryId) as { parentId: string | null } | undefined;
          if (!entry) throw new Error("Invalid entry ID for forking");
          await this.branchInto(onEvent, options?.position === "at" ? entryId : entry.parentId);
          return swapped(options?.withSession);
        },
        navigateTree: async (targetId, options) => {
          const res = await current().navigateTree(targetId, options);
          if (!res.cancelled) onEvent({ kind: "session_changed" });
          return { cancelled: res.cancelled };
        },
        switchSession: async (sessionPath, options) => {
          await this.openSession(onEvent, sessionPath);
          return swapped(options?.withSession);
        },
        reload: async () => {
          await current().reload();
          this.applyToolPolicy();
        },
      },
      onError: (err) =>
        onEvent({ kind: "notice", level: "error", text: `Rozszerzenie ${extensionName(err.extensionPath)} (${err.event}): ${err.error}` }),
    });
  }

  private resolveDefaultModel() {
    const settings = this.services!.settingsManager;
    const provider = settings.getDefaultProvider();
    const modelId = settings.getDefaultModel();
    const model = provider && modelId ? this.services!.modelRuntime.getModel(provider, modelId) : undefined;
    if (!model) {
      throw new Error(`default model not found: ${provider ?? "?"}/${modelId ?? "?"}`);
    }
    return model;
  }

  private async emitInit(onEvent: (e: PiEvent) => void): Promise<void> {
    onEvent({
      kind: "init_done",
      cwd: this.cwd,
      model: this.session?.model?.id ?? "",
      provider: this.session?.model?.provider ?? "",
      sessionId: this.session?.sessionId ?? "",
      sessionPath: this.session?.sessionFile ?? "",
      sessionName: this.session?.sessionName ?? "",
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
    const s = this.requireSession();
    const system = Math.ceil(s.systemPrompt.length / 4);
    const active = new Set(s.getActiveToolNames());
    const defs = s
      .getAllTools()
      .filter((t) => active.has(t.name))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    const tools = Math.ceil(JSON.stringify(defs).length / 4);
    return { system, tools, messages: Math.max(0, total - system - tools) };
  }

  private emitUsage(onEvent: (e: PiEvent) => void): void {
    const u = this.usage();
    if (u) onEvent({ kind: "usage", usage: u });
  }

  async prompt(text: string, images?: Attachment[], behavior?: "steer" | "followUp"): Promise<void> {
    const s = this.requireSession();
    const imgs = images?.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }));
    if (this.busy) {
      // SDK rejects guessing while streaming: default to followUp (don't interrupt).
      if ((behavior ?? "followUp") === "steer") await s.steer(text, imgs);
      else await s.followUp(text, imgs);
      return;
    }
    this.running = true;
    const runs = this.settledRuns;
    try {
      await this.extensionsReady;
      await s.prompt(text, imgs?.length ? { images: imgs } : undefined);
    } finally {
      this.running = false;
      // An extension command may finish without an agent run — the UI still waits for "settled".
      if (this.settledRuns === runs && !s.state.isStreaming) this.emit({ kind: "settled" });
    }
  }

  async abort(): Promise<void> {
    // A run parked on an approval prompt can't observe abort — release it first.
    this.denyAllPending();
    this.dialogs.cancelAll();
    void this.reviewer?.abort();
    this.handoffAbort?.abort();
    const s = this.session;
    if (s && this.busy) await s.abort();
  }

  dispose(): void {
    this.denyAllPending();
    this.dialogs.cancelAll();
    this.session?.dispose();
    this.session = null;
    this.running = false;
  }

  private requireSession(): AgentSession {
    if (!this.session) throw new Error("session not initialized");
    return this.session;
  }

  private requireServices() {
    if (!this.services) throw new Error("not initialized — send init first");
    return this.services;
  }

  private subscribe(session: AgentSession, onEvent: (e: PiEvent) => void): void {
    session.subscribe((event) => {
      // A disposed session may still flush events; drop them.
      if (session !== this.session) return;
      switch (event.type) {
        case "message_update": {
          const a = event.assistantMessageEvent;
          if (a.type === "text_delta") onEvent({ kind: "text_delta", delta: a.delta });
          else if (a.type === "thinking_delta") onEvent({ kind: "thinking_delta", delta: a.delta });
          return;
        }
        case "message_end":
          onEvent({ kind: "message_end" });
          return;
        case "tool_execution_start":
          onEvent({
            kind: "tool_start",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          });
          return;
        case "tool_execution_update":
          onEvent({
            kind: "tool_update",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            partial: summarizeToolResult(event.partialResult),
          });
          return;
        case "tool_execution_end":
          onEvent({
            kind: "tool_end",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: withImages({ isError: event.isError, text: summarizeToolResult(event.result) }, event.result),
          });
          return;
        case "turn_start":
          onEvent({ kind: "turn_start" });
          return;
        case "turn_end":
          onEvent({ kind: "turn_end" });
          this.emitUsage(onEvent);
          return;
        case "agent_end":
          onEvent({ kind: "agent_end" });
          return;
        case "agent_settled": {
          this.settledRuns++;
          this.emitUsage(onEvent);
          const cp = this.runCheckpoint;
          this.runCheckpoint = null;
          // Report restorable file changes before "settled" so the UI attaches them to this turn.
          const done = cp
            ? changesSince(this.cwd, cp)
                .then((files) => {
                  if (files.length) onEvent({ kind: "checkpoint", checkpoint: cp, files: files.map((f) => f.path) });
                })
                .catch(() => undefined)
            : Promise.resolve();
          void done.then(() => onEvent({ kind: "settled" }));
          return;
        }
        case "queue_update":
          onEvent({
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

async function gitBranch(cwd: string): Promise<string> {
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

function userText(content: string | { type: string; text?: string }[]): string {
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

/** Per-model auto-compaction reserve (compaction.modelOverrides) — same private path as setNested. */
function setCompactionOverride(sm: SettingsManager, modelKey: string, reserveTokens: number | undefined): void {
  const internal = sm as unknown as {
    globalSettings: { compaction?: { modelOverrides?: Record<string, Record<string, unknown>> } };
    markModified(field: string, nested?: string): void;
    save(): void;
  };
  const compaction = { ...internal.globalSettings.compaction };
  const overrides = { ...compaction.modelOverrides };
  if (reserveTokens === undefined) {
    const { reserveTokens: _drop, ...rest } = overrides[modelKey] ?? {};
    if (Object.keys(rest).length) overrides[modelKey] = rest;
    else delete overrides[modelKey];
  } else {
    overrides[modelKey] = { ...overrides[modelKey], reserveTokens: Math.max(1000, Math.round(reserveTokens)) };
  }
  internal.globalSettings.compaction = { ...compaction, modelOverrides: overrides };
  internal.markModified("compaction", "modelOverrides");
  internal.save();
}

/**
 * SettingsManager has no public setters for these numbers. Mirror what its own
 * setters do (write global, mark the nested key, save) — the file stays pi-readable.
 */
function setNested(sm: SettingsManager, field: "compaction" | "retry", key: string, value: number): void {
  const internal = sm as unknown as {
    globalSettings: Record<string, Record<string, unknown> | undefined>;
    markModified(field: string, nested?: string): void;
    save(): void;
  };
  internal.globalSettings[field] = { ...internal.globalSettings[field], [key]: value };
  internal.markModified(field, key);
  internal.save();
}

/** "…/pi-lens/dist/index.js" → "pi-lens"; "…/extensions/memory.ts" → "memory". */
function extensionName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const file = parts.pop() ?? path;
  if (!/^index\.[cm]?[jt]s$/.test(file)) return file.replace(/\.[cm]?[jt]s$/, "");
  while (parts.length && ["dist", "src", "lib", "build"].includes(parts[parts.length - 1])) parts.pop();
  return parts.pop() ?? file;
}

/** freedesktop trash through gio (GLib), so the file shows up in Dolphin's trash and can be restored. */
async function trash(file: string): Promise<void> {
  try {
    await run("gio", ["trash", file]);
  } catch (err) {
    const e = err as { code?: string; stderr?: string };
    throw new Error(e.code === "ENOENT" ? "brak programu gio — nie mogę przenieść do kosza" : `kosz: ${String(e.stderr ?? err).trim()}`);
  }
}
