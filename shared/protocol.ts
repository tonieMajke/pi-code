// Shared protocol between sidecar (pi SDK) and UI. JSON lines over stdio.

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** ClientCommand without the id: id is assigned by the transport. */
export type ClientCommandInput = DistributiveOmit<ClientCommand, "id">;

/** How tool calls are gated (Claude Code-style permission modes). */
export type PermissionMode = "ask" | "acceptEdits" | "plan" | "yolo";

export type ApprovalDecision = "allow" | "always" | "deny";

/**
 * `ref` set + empty `data`: the image stays in the sidecar until the UI asks for it
 * (history_image) — history of screenshot-heavy sessions would otherwise be megabytes.
 */
export type Attachment = { data: string; mimeType: string; ref?: string };

export type ClientCommand =
  | { id: number; cmd: "init"; cwd?: string; sessionFile?: string; lang?: Lang }
  /** UI language changed: sidecar messages and tool labels follow. */
  | { id: number; cmd: "lang_set"; lang: Lang }
  | { id: number; cmd: "prompt"; text: string; images?: Attachment[]; behavior?: "steer" | "followUp" }
  | { id: number; cmd: "mode_set"; mode: PermissionMode }
  | { id: number; cmd: "approve"; toolCallId: string; decision: ApprovalDecision; reason?: string }
  | { id: number; cmd: "abort" }
  | { id: number; cmd: "status" }
  | { id: number; cmd: "sessions_list"; cwd?: string }
  | { id: number; cmd: "session_open"; path: string }
  | { id: number; cmd: "session_new"; cwd?: string }
  | { id: number; cmd: "session_rename"; name: string }
  | { id: number; cmd: "history" }
  | { id: number; cmd: "models_list" }
  | { id: number; cmd: "model_set"; provider: string; modelId: string }
  | { id: number; cmd: "rewind"; fromEnd: number }
  | { id: number; cmd: "git_changes" }
  | { id: number; cmd: "git_revert"; path: string }
  | { id: number; cmd: "files_list" }
  | { id: number; cmd: "router_status" }
  | { id: number; cmd: "notify"; title: string; body: string }
  | { id: number; cmd: "settings_get" }
  | { id: number; cmd: "settings_set"; patch: SettingsPatch }
  | { id: number; cmd: "compact"; instructions?: string }
  /** Extension commands, prompt templates and skills the session can run as "/name". */
  | { id: number; cmd: "commands_list" }
  /** User messages of the active branch a new session can be forked from. */
  | { id: number; cmd: "fork_points" }
  /** New session holding the branch up to (not including) that user message; replies with its text. */
  | { id: number; cmd: "session_fork"; entryId: string }
  /** New session with a copy of the active branch. */
  | { id: number; cmd: "session_clone" }
  | { id: number; cmd: "sidebar_get" }
  | { id: number; cmd: "sidebar_set"; state: SidebarState }
  /** Session file to the system trash; reply {path, active} — active = it was open (a new one is started). */
  | { id: number; cmd: "session_delete"; path: string }
  /** Is this a directory? reply {path} normalized, or an error. */
  | { id: number; cmd: "dir_check"; path: string }
  /** One tool-result image left out of history (Attachment.ref); reply Attachment. */
  | { id: number; cmd: "history_image"; ref: string }
  /** Model writes a prompt for a fresh session, then that session starts; reply {prompt, from}. */
  | { id: number; cmd: "session_handoff"; goal?: string }
  | { id: number; cmd: "session_stats" }
  /** Export the session as HTML into the project directory; replies with the path. */
  | { id: number; cmd: "export_html" }
  /** Re-read extensions, skills, prompt templates and context files. */
  | { id: number; cmd: "reload" }
  /** Answer to an extension dialog (ui_request). */
  | { id: number; cmd: "ui_response"; requestId: string; answer: UiAnswer }
  /** Hand the current task to a stronger model ("provider/id"). */
  | { id: number; cmd: "escalate"; model: string; reason: string }
  | { id: number; cmd: "checkpoint_restore"; checkpoint: string }
  | { id: number; cmd: "appearance_get" }
  | { id: number; cmd: "appearance_set"; patch: AppearancePatch }
  /** data: URL of an already downscaled image, or null to remove it. */
  | { id: number; cmd: "appearance_image"; dataUrl: string | null }
  | { id: number; cmd: "memory_get" }
  /** Replace the whole memory (edit, delete, add, reorder); replies MemoryState. */
  | { id: number; cmd: "memory_set"; entries: MemoryEntry[] }
  /** Learn from the current session now instead of when it is left; replies {added: MemoryEntry[]}. */
  | { id: number; cmd: "memory_learn" }
  /** Write global (~/.pi/agent/AGENTS.md) or project (<cwd>/AGENTS.md) instructions; replies MemoryState. */
  | { id: number; cmd: "agents_set"; scope: "global" | "project"; text: string }
  | { id: number; cmd: "providers_list" }
  /** Store an API key for a built-in provider (pi's auth.json); replies ProviderInfo[]. */
  | { id: number; cmd: "provider_key"; provider: string; key: string }
  | { id: number; cmd: "provider_logout"; provider: string }
  /** Ask an OpenAI-compatible server for its models; replies EndpointProbe. */
  | { id: number; cmd: "endpoint_probe"; baseUrl: string; apiKey?: string }
  /** Add or replace a provider in ~/.pi/agent/models.json; replies ProviderInfo[]. */
  | { id: number; cmd: "endpoint_add"; endpoint: CustomEndpoint }
  | { id: number; cmd: "endpoint_remove"; name: string }
  /** Is the first-run welcome done? reply OnboardingState. */
  | { id: number; cmd: "onboarding_get" }
  | { id: number; cmd: "onboarding_done" }
  /** Aggregated llama.cpp request log; reply StatsSummary. */
  | { id: number; cmd: "stats_query"; range: StatsRange }
  | { id: number; cmd: "dispose" };

export type { Lang } from "./i18n.js";
import type { Lang } from "./i18n.js";

/** One remembered fact about the user (see sidecar/src/memory.ts). */
export type MemoryEntry = { id: string; date: string; text: string };

export type MemoryState = {
  file: string;
  entries: MemoryEntry[];
  enabled: boolean;
  learn: boolean;
  /** Path of a pi extension that already does memory; the built-in one stays off while it is loaded. */
  external: string | null;
  agents: {
    global: { path: string; text: string };
    /** null outside a project (cwd = home). */
    project: { path: string; text: string; exists: boolean } | null;
  };
};

export type ProviderInfo = {
  id: string;
  name: string;
  /** Has usable credentials (stored key, env var, keyless local server…). */
  configured: boolean;
  /** Where the credentials come from, e.g. "auth.json", "OPENROUTER_API_KEY". */
  source: string;
  /** Models usable right now. */
  models: number;
  /** An API key can be entered in the GUI. */
  apiKey: boolean;
  /** Needs a browser sign-in — only through `pi` → /login in a terminal. */
  oauthOnly: boolean;
  /** Stored in auth.json by pi (removable with provider_logout). */
  stored: boolean;
  /** Defined in ~/.pi/agent/models.json (removable with endpoint_remove). */
  custom: boolean;
};

/** An OpenAI-compatible server (vLLM, LM Studio, Ollama, SGLang, llama-server…). */
export type CustomEndpoint = {
  name: string;
  baseUrl: string;
  apiKey?: string;
  models: string[];
  /** Context length per model id when the server reports it (vLLM max_model_len). */
  contextWindows?: Record<string, number>;
};

export type EndpointProbe = { baseUrl: string; models: string[]; contextWindows: Record<string, number>; llama: boolean };

export type OnboardingState = {
  done: boolean;
  /** A llama.cpp server answers on localhost:8080. */
  localLlama: boolean;
  /** A default model is set and usable. */
  hasModel: boolean;
  home: string;
};

export type ThemeChoice = "system" | "dark" | "light";

/** Look of the app, stored by the sidecar in ~/.pi/agent/pi-gui-appearance.json. */
export type Appearance = {
  theme: ThemeChoice;
  /** "#rrggbb" or null = theme default. */
  accent: string | null;
  /** "#rrggbb" or null = theme default; a custom background also decides light/dark. */
  background: string | null;
  /** Background picture: dim = 0..0.95 tint of the background colour over it, blur in px. */
  image: { dim: number; blur: number };
  /** data: URL of the stored picture (replies only). */
  imageUrl: string | null;
};

export type AppearancePatch = Partial<Pick<Appearance, "theme" | "accent" | "background">> & {
  image?: Partial<Appearance["image"]>;
};

export type SlashSource = "extension" | "prompt" | "skill";

/** A "/name" command pi itself runs (sent as an ordinary prompt). */
export type SlashCommandInfo = { name: string; description: string; source: SlashSource };

/** A question an extension asks through ctx.ui (select / confirm / input / editor). */
export type UiRequest =
  | { id: string; method: "select"; title: string; options: string[] }
  | { id: string; method: "confirm"; title: string; message: string }
  | { id: string; method: "input"; title: string; placeholder?: string }
  | { id: string; method: "editor"; title: string; prefill?: string };

/** value: the chosen option / typed text, or true/false for confirm. */
export type UiAnswer = { value?: string | boolean; cancelled?: boolean };

export type ForkPoint = { entryId: string; text: string };

export type SessionStats = {
  sessionFile: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
};

export type QueueMode = "all" | "one-at-a-time";

/** GUI-owned rules for the model (see sidecar/src/constitution.ts). */
export type ConstitutionConfig = {
  enabled: boolean;
  /** Hard guards: block edit-before-read and repeated failing calls, force verification before settling. */
  hard: boolean;
  /** Custom rules; empty = built-in default. */
  text: string;
  /** How many times one run may be sent back for verification. */
  maxNudges: number;
};

/** always = schema in every request; deferred = listed by name, model loads it via enable_tools; off = hidden. */
export type ToolPolicy = "always" | "deferred" | "off";

export type SamplingConfig = {
  /** Override the router preset for every request (null fields = leave the preset's value). */
  enabled: boolean;
  temperature: number | null;
  top_p: number | null;
  top_k: number | null;
  min_p: number | null;
  presence_penalty: number | null;
  repeat_penalty: number | null;
  /** Max thinking tokens per model turn (llama.cpp reasoning budget); then the model must act. */
  reasoning_budget_tokens: number | null;
};

/** Everything pi-gui itself configures, stored in ~/.pi/agent/pi-gui.json. */
export type GuiConfig = {
  constitution: ConstitutionConfig;
  /** Per tool name; missing = the built-in default policy. */
  tools: Record<string, ToolPolicy>;
  context: {
    /** Shrink big tool outputs from earlier prompts (re-runnable anyway). */
    elideOldToolOutput: boolean;
    elideAboveChars: number;
  };
  review: {
    /** Skip the review for a verified change smaller than this many changed lines (0 = always review). */
    minLines: number;
    /** Fresh-context review of the diff before the run may finish. */
    enabled: boolean;
    /** "provider/id"; empty = the session's model. */
    model: string;
  };
  escalation: {
    /** "provider/id" offered when the model gets stuck; empty = off. */
    model: string;
    /** Switch back to the previous model once the escalated run ends. */
    revert: boolean;
  };
  sampling: SamplingConfig;
  taste: TasteConfig;
  memory: {
    /** Remembered facts go into every session's system prompt. */
    enabled: boolean;
    /** Facts are extracted when a session is left (and on demand). */
    learn: boolean;
  };
  /** The first-run welcome was completed or skipped. */
  onboarded: boolean;
};

/**
 * "Taste": references before visual work, hard UI measurements, and a fresh-eyes
 * critic that compares the result with the reference before the run may finish.
 */
export type TasteConfig = {
  enabled: boolean;
  /** Collect references before the first visual change: on its own, after asking, or never. */
  research: "auto" | "ask" | "off";
  /** Fresh-context visual review at the end of a run with visual changes. */
  critic: boolean;
  /** "provider/id"; empty = the session's model. */
  criticModel: string;
  /** Critic rounds per answer before giving up (→ escalation card). */
  maxRounds: number;
  /** Page changes must pass ui_audit (no HIGH items) before the run may finish. */
  requireAudit: boolean;
  /** llama.cpp slot for the critic (needs --parallel ≥ 2); null = share the main slot. */
  criticSlot: number | null;
};

/** Everything the settings dialog shows: pi's global settings + live session state. */
export type PiSettings = {
  settingsFile: string;
  defaultModel: string;
  thinking: { level: string; available: string[]; defaultLevel: string };
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  retry: { enabled: boolean; maxRetries: number; baseDelayMs: number };
  images: { autoResize: boolean; blockImages: boolean };
  shellPath: string;
  shellCommandPrefix: string;
  tools: { name: string; description: string; active: boolean; source: string; tokens: number; policy: ToolPolicy }[];
  extensions: { name: string; path: string; source: string }[];
  skills: { name: string; description: string; source: string }[];
  contextFiles: string[];
  constitution: ConstitutionConfig & { defaultText: string; file: string };
  gui: GuiConfig;
  /** Tokens at which pi auto-compacts for the current model (window − reserve). */
  compactAt: number;
  /** The session's model accepts images. */
  modelVision: boolean;
  contextWindow: number;
};

/** One field per call is typical; every key is optional. */
export type SettingsPatch = {
  thinkingLevel?: string;
  defaultThinkingLevel?: string;
  /** "provider/id" — the current model becomes pi's default for new sessions. */
  defaultModel?: string;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  compactionEnabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
  retryEnabled?: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
  imageAutoResize?: boolean;
  blockImages?: boolean;
  shellPath?: string;
  shellCommandPrefix?: string;
  constitution?: Partial<ConstitutionConfig>;
  toolPolicy?: { name: string; policy: ToolPolicy };
  context?: Partial<GuiConfig["context"]>;
  review?: Partial<GuiConfig["review"]>;
  escalation?: Partial<GuiConfig["escalation"]>;
  taste?: Partial<TasteConfig>;
  sampling?: Partial<SamplingConfig>;
  memory?: Partial<GuiConfig["memory"]>;
  /** Auto-compact threshold for the current model; 0 = pi's default. */
  compactAt?: number;
};

export type FileChange = {
  path: string;
  /** git porcelain XY status, e.g. " M", "??", "A ". */
  status: string;
  add: number;
  del: number;
  patch: string;
};

export type GitChanges = { repo: boolean; root: string; files: FileChange[] };

export type GpuInfo = { index: number; name: string; memUsed: number; memTotal: number; util: number };

export type RouterStatus = {
  models: { id: string; status: string }[];
  gpus: GpuInfo[];
};

export type CommandName = ClientCommand["cmd"];

export type ToolStatus = "running" | "ok" | "error";

export type HistoryTool = {
  id: string;
  name: string;
  args: unknown;
  status: "ok" | "error";
  summary: string;
  images?: Attachment[];
};

/** One block of an assistant turn, in the order the model produced it. */
export type HistoryPart =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; tool: HistoryTool }
  /** A constitution guard sent the model back to work. */
  | { type: "notice"; text: string };

/** One rendered item of a restored session transcript. */
export type HistoryItem =
  | { role: "user"; text: string; images?: Attachment[] }
  | { role: "assistant"; parts: HistoryPart[]; stats?: RequestStats[] };

/** Summary of a persisted pi session (from SessionManager.list). */
/** User-made sidebar group; sessions by file path, each in at most one group. */
export type SidebarGroup = { id: string; name: string; sessions: string[] };
/** Sidebar layout kept by the sidecar: groups + projects added without any session yet. */
export type SidebarState = { groups: SidebarGroup[]; projects: string[] };

export type SessionSummary = {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
};

export type ModelSummary = {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  /** Accepts images (the visual critic can look instead of reading an outline). */
  vision?: boolean;
};

export type ToolResultSummary = {
  isError: boolean;
  text: string;
  /** Images the tool returned (look, MCP screenshots, read of a PNG) — what the model saw. */
  images?: Attachment[];
};

export type Usage = {
  /** Estimated tokens currently in context (null right after compaction). */
  contextTokens: number | null;
  contextWindow: number;
  inputTokens: number;
  outputTokens: number;
  /** Rough split of contextTokens (chars/4 estimates; messages = the rest). */
  breakdown?: { system: number; tools: number; messages: number };
};

/** Who a model request was for: the session's own agent loop or a side call. */
export type RequestRole = "main" | "critic" | "reviewer" | "handoff" | "memory" | "compact";

/** Per-request llama.cpp timings (from the streamed `timings` / `prompt_progress`). */
export type Perf =
  | { phase: "prompt"; processed: number; total: number; cache: number; perSec: number }
  | { phase: "gen"; tokens: number; perSec: number; avgPerSec: number }
  | {
      phase: "done";
      promptTokens: number;
      cacheTokens: number;
      promptPerSec: number;
      promptMs: number;
      genTokens: number;
      genPerSec: number;
      genMs: number;
    };

/** Timings of one finished llama.cpp request (what the turn footer shows). */
export type RequestStats = Extract<Perf, { phase: "done" }>;

/** One line of ~/.pi/agent/pi-gui-stats.jsonl. */
export type StatsRecord = {
  ts: number;
  sessionId: string;
  cwd: string;
  role: RequestRole;
  model: string;
  promptTokens: number;
  cacheTokens: number;
  promptMs: number;
  genTokens: number;
  genMs: number;
  ttftMs: number | null;
};

/** Days back, or everything in the log. */
export type StatsRange = 7 | 30 | "all";

export type ModelStats = {
  model: string;
  requests: number;
  promptTokens: number;
  cacheTokens: number;
  genTokens: number;
  /** cache / (processed + cache), 0..100. */
  cacheHitPct: number;
  /** Prompt processing t/s over requests with ≥ 512 fresh tokens (smaller ones are overhead noise); null = none. */
  ppMedian: number | null;
  /** 10th percentile — the slow tail. */
  ppP10: number | null;
  genMedian: number | null;
  genP10: number | null;
  ttftMedianMs: number | null;
};

export type StatsSummary = {
  range: StatsRange;
  file: string;
  total: { requests: number; promptTokens: number; genTokens: number };
  models: ModelStats[];
  /** Local dates "YYYY-MM-DD", oldest first, days without requests included. */
  days: { day: string; promptTokens: number; genTokens: number; requests: number }[];
  projects: { cwd: string; requests: number; promptTokens: number; genTokens: number }[];
  /** Side calls (critic, reviewer, handoff, memory) — what the helpers cost on top of the sessions. */
  overhead: { role: RequestRole; requests: number; promptTokens: number; genTokens: number }[];
};

/** Normalized events the sidecar emits to the UI. */
export type PiEvent =
  | {
      kind: "init_done";
      cwd: string;
      model: string;
      provider: string;
      sessionId: string;
      sessionPath: string;
      sessionName: string;
      branch: string;
      mode: PermissionMode;
      /** OS login name, shown in the sidebar footer. */
      user: string;
    }
  | { kind: "text_delta"; delta: string }
  | { kind: "thinking_delta"; delta: string }
  | { kind: "message_end" }
  | { kind: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { kind: "tool_update"; toolCallId: string; toolName: string; partial: string }
  | { kind: "tool_end"; toolCallId: string; toolName: string; result: ToolResultSummary }
  | { kind: "turn_start" }
  | { kind: "turn_end" }
  | { kind: "agent_end" }
  | { kind: "settled" }
  /** Transcript of a session being opened, sent before the session itself is ready. */
  | { kind: "history"; sessionPath: string; items: HistoryItem[] }
  | { kind: "queue"; steering: number; followUp: number }
  | { kind: "usage"; usage: Usage }
  | { kind: "guard"; label: string }
  /** Facts were added to the user's memory (learned when a session was left, or the model called remember). */
  | { kind: "memory"; added: MemoryEntry[] }
  /** The hard guards gave up — the UI offers escalation. */
  | { kind: "stuck"; label: string; suggest: string }
  /** Files a run changed, restorable to the snapshot taken when it started. */
  | { kind: "checkpoint"; checkpoint: string; files: string[] }
  /** role: side calls (critic…) show live progress but their timings stay out of the turn footer. */
  | { kind: "perf"; perf: Perf; role?: RequestRole }
  | { kind: "mode"; mode: PermissionMode }
  | { kind: "approval_request"; toolCallId: string; toolName: string; args: unknown }
  | { kind: "approval_done"; toolCallId: string; decision: ApprovalDecision }
  | { kind: "status"; busy: boolean }
  /** Message from an extension (ctx.ui.notify) or a dialog the GUI cannot show. */
  | { kind: "notice"; level: "info" | "warning" | "error"; text: string }
  /** An extension wants this text in the composer (ctx.ui.setEditorText). */
  | { kind: "editor_text"; text: string }
  | { kind: "ui_request"; request: UiRequest }
  /** An extension switched or rewound the session — reload the transcript and the session list. */
  | { kind: "session_changed" }
  /** The dialog was closed from the sidecar side (timeout, abort). */
  | { kind: "ui_done"; id: string };

export type SidecarOut =
  | { id: number; cmd?: CommandName; ok: true; result?: unknown }
  | { id: number; cmd?: CommandName; ok: false; error: string }
  | { event: PiEvent };
