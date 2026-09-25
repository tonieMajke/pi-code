import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  convertToLlm,
  createAgentSessionServices,
  initTheme,
  serializeConversation,
  SessionManager,
  type AgentSession,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  ApprovalDecision,
  Attachment,
  BackgroundBlock,
  ForkPoint,
  HistoryItem,
  ModelSummary,
  PermissionMode,
  PiEvent,
  PiSettings,
  SettingsPatch,
  SessionStats,
  SessionSummary,
  SlashCommandInfo,
  Usage,
  StatsRange,
  StatsSummary,
  CustomEndpoint,
  EndpointProbe,
  MemoryEntry,
  MemoryState,
  OnboardingState,
  ProviderInfo,
  UiAnswer,
} from "../../shared/protocol.js";
import { TERMINAL_PRESETS } from "../../shared/terminal.js";
import { SidebarStore } from "./sidebar-store.js";
import { DEFAULT_CONSTITUTION } from "./constitution.js";
import { GuiConfigStore } from "./config.js";
import { HANDOFF_SYSTEM_PROMPT, handoffMessages, handoffUserText } from "./handoff.js";
import { installFetchTap, isLocalBaseUrl, onPerf, onRequestDone, setSampling, withRequestContext } from "./perf.js";
import { aggregate, appendStats, readStats } from "./stats.js";
import { stagedDiff } from "./workspace.js";
import { LEARN_SYSTEM_PROMPT, learningTranscript, learnUserText, MemoryStore, MIN_USER_MESSAGES, parseFacts } from "./memory.js";
import { addEndpoint, endpointId, listProviders, logoutProvider, probeEndpoint, removeEndpoint, setProviderKey } from "./providers.js";
import { setLang, t, type Lang } from "../../shared/i18n.js";
import {
  ENABLE_TOOLS,
  extensionName,
  historyOf,
  SessionHost,
  statsEntries,
  toolImages,
  userText,
  type AgentMessage,
  type HostEnv,
  type Services,
} from "./session-host.js";

export { summarizeToolResult, toolImages } from "./session-host.js";

const run = promisify(execFile);

/** Finished sessions kept in memory besides the one on screen; switching back to them is instant. */
const IDLE_KEEP = 2;

const COMMIT_SYSTEM_PROMPT =
  "You write git commit messages for a staged diff. Output only the message: a subject line under 72 characters, " +
  "then optionally a blank line and a short body saying why, wrapped at 72. Match the style of the repository's " +
  "recent subjects (language, casing, prefixes). No code fences, no quotes, no trailers.";

type Snapshot = { id: string; messages: readonly AgentMessage[]; model: AgentSession["model"] };

/**
 * Registry of live pi sessions. One is on screen (`active`); sessions still working when
 * the user switches away keep running in the background (local models up to a limit),
 * finished ones stay in memory a little while. Events of background sessions reach the UI
 * only as a status line for the sidebar; their transcript comes back with `history`.
 */
export class PiGateway {
  private services: Services | null = null;
  private config: GuiConfigStore | null = null;
  private memory: MemoryStore | null = null;
  /** Permission mode — GUI-wide, survives session switches like Claude Code's. */
  private mode: PermissionMode = "ask";
  private out: (e: PiEvent, session?: string) => void = () => undefined;
  private hosts = new Map<string, SessionHost>();
  private active: SessionHost | null = null;
  /** Folder of the session on screen (kept when there is none yet). */
  private cwd = process.cwd();
  private env: HostEnv = this.makeEnv();
  /** Memory learning in the background (after a session is released); a new run cancels it. */
  private learnAbort: AbortController | null = null;
  private learnQueue: Snapshot[] = [];
  private learning = false;
  /** Per session id: user messages already learned from, so releasing twice doesn't learn twice. */
  private learnedUpTo = new Map<string, number>();
  /** Messages last rendered as history — historyImage looks images up here. */
  private shown: { sessionId: string; messages: readonly AgentMessage[] } | null = null;
  /** The session on screen was handed to a real pi terminal: the GUI must not write to its file. */
  private terminal: { proc: ChildProcess; sessionPath: string; sessionDir: string; startedAt: number } | null = null;
  /** Injectable for tests; the default opens the user's console (detached: false, sidecar stays in charge). */
  spawnTerminal: (argv: string[], cwd: string) => ChildProcess = (argv, cwd) => {
    const proc = spawn(argv[0], argv.slice(1), { cwd, detached: false, stdio: "ignore" });
    proc.on("error", () => undefined); // a missing console must not crash the sidecar
    return proc;
  };

  get ready(): boolean {
    return this.active !== null;
  }

  /** The session is in a real pi terminal right now (see openInTerminal). */
  get terminalOpen(): boolean {
    return this.terminal !== null;
  }

  get busy(): boolean {
    return this.active?.busy ?? false;
  }

  get permissionMode(): PermissionMode {
    return this.mode;
  }

  get workingDir(): string {
    return this.active?.cwd ?? this.cwd;
  }

  /** Base URL of the active model's provider (llama-server router), if it has one. */
  get baseUrl(): string | undefined {
    return this.active?.baseUrl;
  }

  private makeEnv(): HostEnv {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getters below read live fields
    const gw = this;
    return {
      get services() {
        return gw.requireServices();
      },
      get config() {
        return gw.config!;
      },
      get memory() {
        return gw.memory;
      },
      mode: () => this.mode,
      emit: (host, e) => this.route(host, e),
      emitGlobal: (e) => this.out(e),
      activeHost: () => this.active,
      modelByKey: (key) => this.modelByKey(key),
      isRealModel: (m) => this.isReal(m),
      runStarting: () => this.learnAbort?.abort(),
      settled: (host) => this.afterSettled(host),
      startSession: (cwd, sm) => this.startSession(cwd, sm),
      branchInto: (host, leafId) => this.branchInto(host, leafId),
      openSession: (path) => this.openSession(path),
    };
  }

  /** On-screen session: everything. Background: only what the sidebar and toasts need. */
  private route(host: SessionHost, e: PiEvent): void {
    if (host.isDisposed) return;
    if (host === this.active) {
      this.out(e, host.id);
      return;
    }
    if (e.kind === "session_status" || e.kind === "memory" || (e.kind === "notice" && e.level === "error")) this.out(e, host.id);
  }

  private requireHost(): SessionHost {
    if (this.terminal) throw new Error("Sesja otwarta w terminalu");
    if (!this.active) throw new Error("session not initialized");
    return this.active;
  }

  private requireServices(): Services {
    if (!this.services) throw new Error("not initialized — send init first");
    return this.services;
  }

  private isReal(m: AgentSession["model"]): boolean {
    return Boolean(m && this.services?.modelRuntime?.getModel(m.provider, m.id));
  }

  private modelByKey(key: string) {
    const slash = key.indexOf("/");
    const model = this.requireServices().modelRuntime.getModel(key.slice(0, slash), key.slice(slash + 1));
    if (!model) throw new Error(`model not found: ${key}`);
    return model;
  }

  private get statsFile(): string {
    return process.env.PI_GUI_STATS ?? join(this.requireServices().agentDir, "pi-gui-stats.jsonl");
  }

  async init(onEvent: (e: PiEvent, session?: string) => void, cwd?: string, lang?: Lang): Promise<void> {
    if (lang) setLang(lang);
    this.out = onEvent;
    // Idempotent: a re-init (e.g. a second UI client, a reloaded page) re-emits init_done
    // and where every session in memory stands.
    if (this.active) {
      await this.active.emitInit();
      for (const h of this.hosts.values()) onEvent(h.statusEvent(), h.id);
      return;
    }
    const workingDir = cwd ?? process.cwd();
    this.cwd = workingDir;
    installFetchTap();
    onPerf((perf, ctx) => {
      const host = ctx ? this.hosts.get(ctx.sessionId) : this.active;
      host?.onPerf(perf, ctx?.role);
    });
    onRequestDone((r) => {
      const { ctx, model, ttftMs, phase: _phase, promptPerSec: _pp, genPerSec: _gp, ...timings } = r;
      appendStats(this.statsFile, { ts: Date.now(), sessionId: ctx?.sessionId ?? "", cwd: ctx?.cwd ?? "", role: ctx?.role ?? "main", model, ttftMs, ...timings });
      if (ctx?.role === "main" && ctx.sessionId) {
        const { model: _m, ttftMs: _t, ctx: _c, ...stats } = r;
        this.hosts.get(ctx.sessionId)?.addRunStats(stats);
      }
    });
    this.services = await createAgentSessionServices({ cwd: workingDir });
    // pi's main() does this for every mode; extensions with a UI format text with the theme.
    initTheme(this.services.settingsManager.getTheme(), false);
    // PI_GUI_CONFIG lets the eval harness run profiles without touching the user's file.
    this.config = new GuiConfigStore(process.env.PI_GUI_CONFIG ?? `${this.services.agentDir}/pi-gui.json`);
    setSampling(this.config.get().sampling);
    this.memory = new MemoryStore(process.env.PI_GUI_MEMORY ?? join(this.services.agentDir, "memory", "user.md"));
    // PI_GUI_EPHEMERAL (eval harness): keep throwaway runs out of the user's session history.
    const sm = process.env.PI_GUI_EPHEMERAL ? SessionManager.inMemory(workingDir) : SessionManager.create(workingDir);
    await this.startSession(workingDir, sm);
  }

  // ── Sessions: create, show, leave, release ────────────────────────────────

  /**
   * A fresh agent for a session file (or a new one) becomes the session on screen.
   * `prev` = the session being left (already detached by openSession).
   */
  private async startSession(cwd: string, sessionManager: SessionManager, prev = this.active): Promise<void> {
    await prev?.extensionsReady; // never leave a session its extensions are still starting on
    // From here on the session being left is not on screen: while the new one starts
    // (~0.2–0.5 s), a run still going there must not stream into the new, empty view.
    this.active = null;
    const model = (prev && this.isReal(prev.session.model) ? prev.session.model : undefined) ?? this.resolveDefaultModel();
    let host: SessionHost;
    try {
      host = await SessionHost.start(this.env, cwd, sessionManager, model ?? undefined);
    } catch (err) {
      this.active = prev;
      throw err;
    }
    this.hosts.set(host.id, host);
    this.show(host, prev);
    await host.emitInit();
    host.emitUsage();
  }

  private show(host: SessionHost, prev = this.active): void {
    this.active = host;
    this.cwd = host.cwd;
    host.lastSeen = Date.now();
    // Finished while away: now it has been seen.
    if (host.status === "done" || host.status === "error") host.setStatus("idle");
    if (prev && prev !== host) {
      prev.lastSeen = Date.now();
      this.trimIdle();
    }
  }

  /** Finished sessions beyond IDLE_KEEP are released, oldest first. */
  private trimIdle(): void {
    const idle = [...this.hosts.values()].filter((h) => h !== this.active && !h.busy).sort((a, b) => b.lastSeen - a.lastSeen);
    for (const h of idle.slice(IDLE_KEEP)) void this.release(h);
  }

  /**
   * Out of memory: extensions and MCP connections close. This is "leaving" a session —
   * the moment memory learns from it (not every switch: that would run the model while
   * another session may need its only slot).
   */
  private async release(host: SessionHost, learn = true): Promise<void> {
    if (host.isDisposed || !this.hosts.has(host.id)) return;
    this.hosts.delete(host.id);
    await host.extensionsReady.catch(() => undefined);
    const snap: Snapshot = { id: host.id, messages: [...host.session.state.messages], model: host.session.model };
    const memoryOn = host.memoryActive();
    const path = host.path;
    host.dispose();
    this.out({ kind: "session_closed", session: snap.id, path });
    if (learn && memoryOn && this.config!.get().memory.learn) {
      this.learnQueue.push(snap);
      void this.drainLearn();
    }
  }

  private afterSettled(host: SessionHost): void {
    if (host !== this.active) this.trimIdle();
    void this.drainLearn();
  }

  /**
   * Before leaving the session on screen. Working on an API model: it simply goes on in the
   * background. On a local model: up to `background.localLimit` such sessions; 0 = leaving
   * stops it (the old behaviour); over the limit → the UI asks which one to stop (null = go).
   */
  async prepareSwitch(stop?: string): Promise<BackgroundBlock | null> {
    if (stop) {
      await this.stopSession(stop);
      return null;
    }
    const cur = this.active;
    if (!cur || !cur.busy || !cur.isLocal) return null;
    const limit = this.config!.get().background.localLimit;
    if (limit <= 0) {
      await cur.abort();
      return null;
    }
    const running = [...this.hosts.values()].filter((h) => h !== cur && h.busy && h.isLocal);
    if (running.length < limit) return null;
    return {
      limit,
      running: [cur, ...running].map((h) => ({ session: h.id, title: h.title || t("Nowa sesja"), active: h === cur })),
    };
  }

  /** Sidebar "Stop" / the limit dialog: stop a session's run; a background one is released too. */
  async stopSession(id: string): Promise<void> {
    const host = this.hosts.get(id);
    if (!host) return;
    await host.abort();
    if (host !== this.active) await this.release(host);
  }

  /** Sidebar "open": a session in memory comes back as it is, anything else is loaded from its file. */
  async openSession(path: string): Promise<void> {
    this.requireServices();
    const target = resolve(path);
    const live = [...this.hosts.values()].find((h) => h.path && resolve(h.path) === target);
    if (live) {
      this.bringBack(live);
      return;
    }
    const sessionManager = SessionManager.open(path);
    // The session being left stops talking to the view before the new transcript goes out.
    const prev = this.active;
    this.active = null;
    // Show the transcript straight from the file (~20 ms); the agent session with its
    // extensions takes up to ~0.5 s more when the project changes.
    const messages = sessionManager.buildSessionContext().messages;
    this.shown = { sessionId: sessionManager.getSessionId(), messages };
    const items = historyOf(sessionManager.getSessionId(), messages, statsEntries(sessionManager));
    this.out({ kind: "history", sessionPath: sessionManager.getSessionFile() ?? path, items });
    // Tools must run in the session's own project, not wherever the GUI started.
    const cwd = sessionManager.getCwd() || this.cwd;
    await this.startSession(cwd, sessionManager, prev);
  }

  /** A session from memory back on screen: transcript (with the message still streaming), then its state. */
  private bringBack(host: SessionHost): void {
    this.show(host);
    this.shown = { sessionId: host.id, messages: host.historyMessages() };
    this.out(
      { kind: "history", sessionPath: host.path, items: host.historyItems(), busy: host.busy, since: host.busySince ?? undefined },
      host.id,
    );
    void host.emitInit().then(() => {
      host.emitUsage();
      host.replay();
    });
  }

  /** Start a brand-new empty session (UI "Nowa sesja"). */
  async newSession(cwd?: string): Promise<void> {
    this.requireServices();
    const target = cwd ?? this.cwd;
    await this.startSession(target, SessionManager.create(target));
  }

  // ── Session in a real terminal (pi TUI: /settings, /login…) ──────────────

  /**
   * The terminal is a second process on the same session file, so the GUI releases the
   * session and stops writing to it until the terminal exits (or terminalTakeback).
   */
  async openInTerminal(): Promise<void> {
    const host = this.requireHost();
    const sessionPath = host.path;
    if (!sessionPath) throw new Error("sesja nie ma jeszcze pliku");
    const sessionDir = host.session.sessionManager.getSessionDir();
    const cwd = host.cwd;
    const template = this.config!.get().terminal ?? TERMINAL_PRESETS.konsole;
    // Plain space split after placeholder substitution (paths with spaces are not supported).
    let argv = template.replaceAll("{cwd}", cwd).replaceAll("{session}", sessionPath).split(" ").filter(Boolean);
    if (this.config!.get().terminalFork) {
      // A copy of the session (--fork): the GUI keeps the original and keeps working — no abort, no release,
      // nothing to restore when the terminal exits (the copy shows up in the session list on its own).
      argv = argv.map((a) => (a === "--session" ? "--fork" : a));
      const proc = this.spawnTerminal(argv, cwd);
      // A spawn failure (missing console) would be invisible otherwise — the UI toasts the error from this event.
      proc.on("error", (err) => this.out({ kind: "terminal_state", open: false, error: err instanceof Error ? err.message : String(err) }));
      return;
    }
    if (host.busy) await host.abort();
    await this.release(host);
    this.active = null;
    const proc = this.spawnTerminal(argv, cwd);
    this.terminal = { proc, sessionPath, sessionDir, startedAt: Date.now() };
    proc.on("exit", () => void this.closeTerminal());
    // A spawn that fails (missing console) emits only "error" — close through the same path.
    proc.on("error", (err) => void this.closeTerminal(err instanceof Error ? err.message : String(err)));
    this.out({ kind: "terminal_state", open: true, sessionPath });
  }

  /** Kill the terminal and bring the session back now; a second call is a no-op. */
  async terminalTakeback(): Promise<void> {
    if (!this.terminal) return;
    this.terminal.proc.kill();
    await this.closeTerminal();
  }

  /**
   * The terminal exited (or was taken back): refresh resources and bring the session back.
   * Always ends with terminal_state {open:false}; failures go to the UI as its error.
   */
  private async closeTerminal(terminalError?: string): Promise<void> {
    const term = this.terminal;
    if (!term) return; // takeback and the exit event must not double-close
    this.terminal = null;
    let error = terminalError;
    try {
      // The terminal may have added extensions, skills or credentials — same refresh as /reload.
      await this.services?.resourceLoader.reload().catch(() => undefined);
      // pi may have started a new session file in there (/new): take the newest one touched since.
      const file = this.newestSessionFile(term.sessionDir, term.startedAt) ?? term.sessionPath;
      await this.openSession(file);
    } catch (err) {
      error ??= err instanceof Error ? err.message : String(err);
    }
    this.out({ kind: "terminal_state", open: false, ...(error ? { error } : {}) });
  }

  /** Newest .jsonl in the session directory modified after startedAt; null = keep the original. */
  private newestSessionFile(dir: string, startedAt: number): string | null {
    let newest: string | null = null;
    let mtime = startedAt;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (!name.isFile() || !name.name.endsWith(".jsonl")) continue;
      const path = join(dir, name.name);
      const m = statSync(path).mtimeMs;
      if (m > mtime) {
        mtime = m;
        newest = path;
      }
    }
    return newest;
  }

  // ── Commands routed to a session ──────────────────────────────────────────

  private hostFor(session?: string): SessionHost {
    if (this.terminal) throw new Error("Sesja otwarta w terminalu");
    if (!session) return this.requireHost();
    const host = this.hosts.get(session);
    if (!host) throw new Error(t("tej sesji nie ma już w pamięci"));
    return host;
  }

  prompt(text: string, images?: Attachment[], behavior?: "steer" | "followUp", session?: string): Promise<void> {
    return this.hostFor(session).prompt(text, images, behavior);
  }

  async abort(session?: string): Promise<void> {
    const host = session ? this.hosts.get(session) : this.active;
    await host?.abort();
  }

  /** Approvals are unique per tool call — whichever session asked gets the answer. */
  approve(toolCallId: string, decision: ApprovalDecision, reason?: string): void {
    for (const h of this.hosts.values()) if (h.hasApproval(toolCallId)) return h.approve(toolCallId, decision, reason);
  }

  answerDialog(requestId: string, answer: UiAnswer): void {
    for (const h of this.hosts.values()) if (h.answerDialog(requestId, answer)) return;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
    this.out({ kind: "mode", mode });
  }

  history(): HistoryItem[] {
    const host = this.requireHost();
    this.shown = { sessionId: host.id, messages: host.historyMessages() };
    return host.historyItems();
  }

  /** An image history() left out; ref = sessionId/toolCallId/index. */
  historyImage(ref: string): Attachment {
    const [sessionId, toolCallId, index] = ref.split("/");
    // The transcript on screen may be an early preview of a session still starting (openSession).
    const messages = this.shown?.sessionId === sessionId ? this.shown.messages : (this.hosts.get(sessionId)?.historyMessages() ?? null);
    if (!messages) throw new Error("obraz z innej sesji");
    const msg = messages.find((m) => m.role === "toolResult" && m.toolCallId === toolCallId);
    const img = msg?.role === "toolResult" ? toolImages({ content: msg.content })[Number(index)] : undefined;
    if (!img) throw new Error("nie ma takiego obrazu");
    return { ...img, ref };
  }

  escalate(key: string, reason: string): Promise<void> {
    return this.requireHost().escalate(key, reason);
  }

  restoreCheckpoint(checkpoint: string): Promise<string[]> {
    return this.requireHost().restoreCheckpoint(checkpoint);
  }

  setModel(provider: string, modelId: string): Promise<void> {
    return this.requireHost().setModel(provider, modelId);
  }

  compact(instructions?: string): Promise<void> {
    return this.requireHost().compact(instructions);
  }

  rewind(fromEnd: number): Promise<string> {
    return this.requireHost().rewind(fromEnd);
  }

  commands(): SlashCommandInfo[] {
    return this.requireHost().commands();
  }

  forkPoints(): ForkPoint[] {
    return this.requireHost().forkPoints();
  }

  stats(): SessionStats {
    return this.requireHost().stats();
  }

  exportHtml(): Promise<string> {
    return this.requireHost().exportHtml();
  }

  reload(): Promise<void> {
    return this.requireHost().reload();
  }

  rename(name: string): Promise<void> {
    return this.requireHost().rename(name);
  }

  usage(): Usage | null {
    return this.active?.usage() ?? null;
  }

  /**
   * New session with the branch up to (not including) that user message — pi's /fork.
   * Returns the message text so the UI can put it back in the composer.
   */
  async fork(entryId: string): Promise<string> {
    const host = this.requireHost();
    const s = host.session;
    if (host.busy) throw new Error("model pracuje — fork po zakończeniu");
    const entry = s.sessionManager.getEntry(entryId) as
      | { type: string; parentId: string | null; message?: { role: string; content: Parameters<typeof userText>[0] } }
      | undefined;
    if (!entry || entry.type !== "message" || entry.message?.role !== "user") throw new Error("nie ma takiej wiadomości w sesji");
    const text = userText(entry.message.content);
    await this.branchInto(host, entry.parentId);
    return text;
  }

  /** New session with a copy of the active branch — pi's /clone. */
  async clone(): Promise<void> {
    const host = this.requireHost();
    if (host.busy) throw new Error("model pracuje — kopia po zakończeniu");
    const leaf = host.session.sessionManager.getLeafId();
    if (!leaf) throw new Error("sesja jest pusta — nie ma czego kopiować");
    await this.branchInto(host, leaf);
  }

  /**
   * pi-style /handoff: the current model writes a self-contained prompt from this
   * branch, then a fresh session (child of this one) starts in the same cwd.
   * The prompt is returned, not sent — the UI puts it in the composer.
   */
  async handoff(goal: string): Promise<{ prompt: string; from: string }> {
    const host = this.requireHost();
    const s = host.session;
    if (host.busy || host.handoffAbort) throw new Error("model pracuje — handoff po zakończeniu");
    if (!s.model) throw new Error("brak modelu");
    const messages = handoffMessages(s.sessionManager.getBranch() as never);
    if (!messages.length) throw new Error("sesja jest pusta — nie ma czego przekazać");
    const conversation = serializeConversation(convertToLlm(messages as never));
    // Same title the sidebar shows: the name, else the first user message.
    const first = messages.find((m) => (m as { role?: string }).role === "user") as { content: Parameters<typeof userText>[0] } | undefined;
    const from = (s.sessionName || (first ? userText(first.content) : "")).replace(/\s+/g, " ").trim();
    const title = from.length > 60 ? `${from.slice(0, 59)}…` : from;
    const abort = (host.handoffAbort = new AbortController());
    let prompt: string;
    try {
      const model = s.model;
      const res = await withRequestContext({ sessionId: s.sessionId, cwd: host.cwd, role: "handoff" }, () =>
        s.modelRuntime.complete(
          model,
          {
            systemPrompt: HANDOFF_SYSTEM_PROMPT,
            messages: [{ role: "user", content: [{ type: "text", text: handoffUserText(conversation, goal) }], timestamp: Date.now() }],
          },
          { signal: abort.signal, cacheRetention: "none", sessionId: randomUUID() },
        ),
      );
      if (res.stopReason === "aborted" || abort.signal.aborted) throw new Error("handoff przerwany");
      if (res.stopReason === "error") throw new Error(res.errorMessage || "model zwrócił błąd");
      prompt = res.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("\n")
        .trim();
    } finally {
      host.handoffAbort = null;
    }
    if (!prompt) throw new Error("model nie napisał handoffu");
    // Persisted parent → the new session keeps a link back (like pi's /handoff).
    const file = s.sessionManager.isPersisted() && s.sessionFile && existsSync(s.sessionFile) ? s.sessionFile : undefined;
    const sm = SessionManager.create(host.cwd, s.sessionManager.getSessionDir());
    if (file) sm.newSession({ parentSession: file });
    await this.startSession(host.cwd, sm);
    return { prompt, from: title };
  }

  /** Same file handling as pi's runtime fork: a new session file holding root → leafId. */
  private async branchInto(host: SessionHost, leafId: string | null): Promise<void> {
    const s = host.session;
    if (!s.sessionManager.isPersisted()) throw new Error("sesja nie jest zapisywana na dysk");
    const file = s.sessionFile;
    const dir = s.sessionManager.getSessionDir();
    if (!leafId) {
      // Forking before the very first message: an empty session that remembers its parent.
      const sm = SessionManager.create(host.cwd, dir);
      sm.newSession({ parentSession: file });
      await this.startSession(host.cwd, sm);
      return;
    }
    if (!file || !existsSync(file)) throw new Error("sesja nie jest jeszcze zapisana — poczekaj na pierwszą odpowiedź modelu");
    const sm = SessionManager.open(file, dir);
    if (!sm.createBranchedSession(leafId)) throw new Error("nie udało się utworzyć nowej sesji");
    await this.startSession(sm.getCwd() || host.cwd, sm);
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
   * Move a session file to the system trash (recoverable). Its run stops; deleting the
   * open session starts a fresh one in the same project.
   */
  async deleteSession(path: string): Promise<{ path: string; active: boolean }> {
    const root = resolve(this.requireServices().agentDir, "sessions");
    const file = resolve(path);
    if (!file.startsWith(root + sep) || !file.endsWith(".jsonl")) throw new Error("to nie jest plik sesji pi");
    const host = [...this.hosts.values()].find((h) => h.path && resolve(h.path) === file);
    const active = !!host && host === this.active;
    if (host) {
      await host.abort();
      await host.extensionsReady;
    }
    if (existsSync(file)) await this.trashFile(file);
    this.sidebar.forget(path);
    if (host && active) await this.newSession(host.cwd);
    // Nothing to learn from a chat the user threw away.
    if (host) await this.release(host, false);
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

  // ── Memory ────────────────────────────────────────────────────────────────

  /** A local model server is busy with some session's run — learning would take its slot. */
  private slotTaken(model: AgentSession["model"]): boolean {
    if (!isLocalBaseUrl((model as { baseUrl?: string } | undefined)?.baseUrl)) return false;
    return [...this.hosts.values()].some((h) => h.busy && h.isLocal);
  }

  /** Learn from released sessions one by one, whenever no working session needs the model server. */
  private async drainLearn(): Promise<void> {
    if (this.learning) return;
    this.learning = true;
    try {
      while (this.learnQueue.length) {
        const snap = this.learnQueue[0];
        if (this.slotTaken(snap.model)) return; // retried when a run settles
        this.learnQueue.shift();
        const added = await this.learnFrom(snap);
        if (added === null) {
          this.learnQueue.unshift(snap); // a run started and took the server back
          return;
        }
        if (added.length) this.out({ kind: "memory", added });
      }
    } finally {
      this.learning = false;
    }
  }

  /**
   * Extract durable facts from a conversation into memory. Runs when a session is
   * released (not after every answer: with one llama.cpp slot that would evict the
   * conversation's KV cache mid-work) and on demand from the settings.
   * null = aborted by a run that needed the model server.
   */
  private async learnFrom(snap: Snapshot, force = false): Promise<MemoryEntry[] | null> {
    if (!this.memory || !this.config?.get().memory.enabled || !snap.model) return [];
    const { text, userMessages } = learningTranscript(snap.messages as never);
    const done = this.learnedUpTo.get(snap.id) ?? 0;
    if (!force && (userMessages < MIN_USER_MESSAGES || userMessages <= done)) return [];
    if (!text.trim()) return [];
    this.learnAbort?.abort();
    const abort = (this.learnAbort = new AbortController());
    try {
      const existing = this.memory.read();
      const res = await withRequestContext({ sessionId: snap.id, cwd: this.cwd, role: "memory" }, () =>
        this.requireServices().modelRuntime.complete(
          snap.model!,
          {
            systemPrompt: LEARN_SYSTEM_PROMPT,
            messages: [{ role: "user", content: [{ type: "text", text: learnUserText(existing, text) }], timestamp: Date.now() }],
          },
          { signal: abort.signal, cacheRetention: "none", sessionId: randomUUID(), maxTokens: 6000 },
        ),
      );
      if (res.stopReason === "aborted" || abort.signal.aborted) return null;
      if (res.stopReason === "error") return [];
      const out = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      this.learnedUpTo.set(snap.id, userMessages);
      return this.memory.add(parseFacts(out, existing));
    } catch {
      return abort.signal.aborted ? null : []; // best effort: never break a session switch over memory
    } finally {
      if (this.learnAbort === abort) this.learnAbort = null;
    }
  }

  memoryState(): MemoryState {
    const services = this.requireServices();
    const cfg = this.config!.get().memory;
    const read = (f: string) => {
      try {
        return readFileSync(f, "utf8");
      } catch {
        return "";
      }
    };
    const cwd = this.workingDir;
    const globalPath = join(services.agentDir, "AGENTS.md");
    const inProject = cwd !== homedir() && cwd !== "/";
    const projectPath = join(cwd, "AGENTS.md");
    return {
      file: this.memory!.file,
      entries: this.memory!.read(),
      enabled: cfg.enabled,
      learn: cfg.learn,
      external: this.active?.externalMemory() ?? null,
      agents: {
        global: { path: globalPath, text: read(globalPath) },
        project: inProject ? { path: projectPath, text: read(projectPath), exists: existsSync(projectPath) } : null,
      },
    };
  }

  setMemory(entries: MemoryEntry[]): MemoryState {
    this.memory!.write(entries);
    return this.memoryState();
  }

  /** "Learn from this chat now" in the settings. */
  async learnNow(): Promise<MemoryEntry[]> {
    const host = this.requireHost();
    const s = host.session;
    if (host.busy) throw new Error(t("model pracuje — spróbuj po zakończeniu"));
    if (!host.memoryActive()) throw new Error(t("pamięć jest wyłączona"));
    if (this.slotTaken(s.model)) throw new Error(t("inna sesja pracuje na tym modelu — spróbuj, gdy skończy"));
    return (await this.learnFrom({ id: s.sessionId, messages: s.state.messages, model: s.model }, true)) ?? [];
  }

  /** Global or project AGENTS.md; empty text removes nothing, it writes an empty file. */
  setAgents(scope: "global" | "project", text: string): MemoryState {
    const state = this.memoryState();
    const target = scope === "global" ? state.agents.global.path : state.agents.project?.path;
    if (!target) throw new Error(t("ta sesja nie ma folderu projektu"));
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, text.endsWith("\n") || !text ? text : `${text}\n`);
    return this.memoryState();
  }

  // ── Stats & git helpers ───────────────────────────────────────────────────

  statsQuery(range: StatsRange): StatsSummary {
    return aggregate(readStats(this.statsFile), range, this.statsFile);
  }

  /** One-shot proposal for the changes panel; nothing is committed. */
  async commitMessage(): Promise<string> {
    const host = this.requireHost();
    const s = host.session;
    const model = this.isReal(s.model) ? s.model : undefined;
    if (!model) throw new Error(t("brak modelu"));
    const { diff, recent } = await stagedDiff(host.cwd);
    if (!diff.trim()) throw new Error(t("nic nie jest dodane do commitu"));
    const text = `Recent subjects in this repository:\n${recent.map((r) => `- ${r}`).join("\n") || "(none)"}\n\nStaged diff:\n${diff}`;
    const res = await withRequestContext({ sessionId: host.id, cwd: host.cwd, role: "commit" }, () =>
      s.modelRuntime.complete(
        model,
        { systemPrompt: COMMIT_SYSTEM_PROMPT, messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] },
        { cacheRetention: "none", sessionId: randomUUID(), maxTokens: 4000 },
      ),
    );
    if (res.stopReason === "error") throw new Error(res.errorMessage || t("model zwrócił błąd"));
    const out = res.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("\n")
      .replace(/^```\w*\n?|```$/gm, "")
      .trim();
    if (!out) throw new Error(t("model nie zaproponował opisu"));
    return out;
  }

  // ── Providers & first run ─────────────────────────────────────────────────

  private get modelsFile(): string {
    return process.env.PI_GUI_MODELS ?? join(this.requireServices().agentDir, "models.json");
  }

  providers(): Promise<ProviderInfo[]> {
    return listProviders(this.requireServices().modelRuntime, this.modelsFile);
  }

  /** After credentials or models.json change: reload pi's model list; a session without a model gets one. */
  private async providersChanged(): Promise<ProviderInfo[]> {
    const rt = this.requireServices().modelRuntime;
    await rt.refresh({ allowNetwork: false }).catch(() => undefined);
    const host = this.active;
    if (host && !this.isReal(host.session.model)) {
      // The snapshot fills asynchronously after refresh — ask for the list itself.
      const model = this.resolveDefaultModel() ?? (await rt.getAvailable().catch(() => []))[0];
      if (model) {
        await host.session.setModel(model);
        // First provider on a fresh install: it becomes the default for new sessions too.
        const sm = this.requireServices().settingsManager;
        if (!sm.getDefaultModel()) {
          sm.setDefaultModelAndProvider(model.provider, model.id);
          await sm.flush();
        }
        await host.emitInit();
      }
    }
    return this.providers();
  }

  async providerKey(provider: string, key: string): Promise<ProviderInfo[]> {
    if (!key.trim()) throw new Error(t("pusty klucz API"));
    await setProviderKey(this.requireServices().modelRuntime, provider, key);
    return this.providersChanged();
  }

  async providerLogout(provider: string): Promise<ProviderInfo[]> {
    await logoutProvider(this.requireServices().modelRuntime, provider);
    return this.providersChanged();
  }

  probeEndpoint(baseUrl: string, apiKey?: string): Promise<EndpointProbe> {
    return probeEndpoint(baseUrl, apiKey);
  }

  async addEndpoint(ep: CustomEndpoint): Promise<ProviderInfo[]> {
    // Same id as a built-in or extension provider would silently replace its models.
    const id = endpointId(ep.name);
    const taken = (await this.providers()).find((p) => p.id === id && !p.custom);
    if (taken) throw new Error(t("nazwa „{name}” należy już do dostawcy {provider} — wybierz inną", { name: ep.name, provider: taken.name }));
    addEndpoint(this.modelsFile, ep);
    return this.providersChanged();
  }

  async removeEndpoint(id: string): Promise<ProviderInfo[]> {
    removeEndpoint(this.modelsFile, id);
    return this.providersChanged();
  }

  async onboarding(): Promise<OnboardingState> {
    const localLlama = await fetch("http://127.0.0.1:8080/health", { signal: AbortSignal.timeout(1500) })
      .then((r) => (r.headers.get("server") ?? "").toLowerCase().includes("llama.cpp"))
      .catch(() => false);
    return { done: this.config!.get().onboarded, localLlama, hasModel: Boolean(this.active && this.isReal(this.active.session.model)), home: homedir() };
  }

  finishOnboarding(): void {
    this.config!.setOnboarded();
  }

  setLanguage(lang: Lang): void {
    setLang(lang);
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  /** Snapshot for the settings dialog: pi's global settings + what this session loaded. */
  settings(): PiSettings {
    const s = this.requireHost().session;
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
        ...(!s.supportsThinking() && isLocalBaseUrl((s.model as { baseUrl?: string } | undefined)?.baseUrl)
          ? { server: { budget: this.config?.get().sampling.reasoning_budget_tokens || null } }
          : {}),
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
        .filter((tool) => tool.name !== ENABLE_TOOLS)
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          active: active.has(tool.name),
          source: src(tool.sourceInfo),
          tokens: Math.ceil(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length / 4),
          policy: this.config!.toolPolicy(tool.name),
        })),
      extensions: loader
        .getExtensions()
        .extensions.filter((e) => !e.hidden)
        .map((e) => ({ name: extensionName(e.resolvedPath), path: e.resolvedPath, source: src(e.sourceInfo) }))
        .concat(this.config!.get().extensions.disabled.map((name) => ({ name, path: "", source: "", disabled: true }))),
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

  async updateSettings(patch: SettingsPatch): Promise<PiSettings> {
    const host = this.requireHost();
    const s = host.session;
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
    if (patch.background?.localLimit !== undefined) config.update("background", { localLimit: Math.max(0, Math.min(8, Math.round(patch.background.localLimit))) });
    if (patch.turnLimit) {
      const { enabled, steps, minutes } = patch.turnLimit;
      config.update("turnLimit", {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(steps !== undefined ? { steps: Math.max(1, Math.min(100, Math.round(steps))) } : {}),
        ...(minutes !== undefined ? { minutes: Math.max(1, Math.min(60, Math.round(minutes))) } : {}),
      });
    }
    if (patch.extension) {
      config.setExtension(patch.extension.name, patch.extension.enabled);
      for (const h of this.hosts.values()) h.extensionsChanged();
    }
    if (patch.memory) {
      config.update("memory", patch.memory);
      for (const h of this.hosts.values()) h.policyChanged(); // the remember tool follows the switch
    }
    if (patch.sampling) {
      config.update("sampling", patch.sampling);
      setSampling(config.get().sampling);
    }
    if (patch.terminal !== undefined) config.setTerminal(patch.terminal ?? undefined);
    if (patch.terminalFork !== undefined) config.setTerminalFork(patch.terminalFork);
    if (patch.toolPolicy) {
      config.setToolPolicy(patch.toolPolicy.name, patch.toolPolicy.policy);
      for (const h of this.hosts.values()) h.policyChanged(patch.toolPolicy);
      host.emitUsage(); // tool schemas are part of the context
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

  private resolveDefaultModel() {
    const settings = this.services!.settingsManager;
    const provider = settings.getDefaultProvider();
    const modelId = settings.getDefaultModel();
    const runtime = this.services!.modelRuntime;
    const model = provider && modelId ? runtime.getModel(provider, modelId) : undefined;
    // Fresh install or a provider that went away: any usable model, else none — the
    // session still opens and the welcome screen / settings can add a provider.
    return model ?? runtime.getAvailableSnapshot()[0];
  }

  dispose(): void {
    this.terminal?.proc.kill();
    this.terminal = null;
    for (const h of this.hosts.values()) h.dispose();
    this.hosts.clear();
    this.active = null;
  }
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

/** freedesktop trash through gio (GLib), so the file shows up in Dolphin's trash and can be restored. */
async function trash(file: string): Promise<void> {
  try {
    await run("gio", ["trash", file]);
  } catch (err) {
    const e = err as { code?: string; stderr?: string };
    throw new Error(e.code === "ENOENT" ? "brak programu gio — nie mogę przenieść do kosza" : `kosz: ${String(e.stderr ?? err).trim()}`);
  }
}
