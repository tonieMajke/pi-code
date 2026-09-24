// Shared protocol between sidecar (pi SDK) and UI. JSON lines over stdio.

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** ClientCommand without the id: id is assigned by the transport. */
export type ClientCommandInput = DistributiveOmit<ClientCommand, "id">;

/** How tool calls are gated (Claude Code-style permission modes). */
export type PermissionMode = "ask" | "acceptEdits" | "plan" | "yolo";

export type ApprovalDecision = "allow" | "always" | "deny";

export type Attachment = { data: string; mimeType: string };

export type ClientCommand =
  | { id: number; cmd: "init"; cwd?: string; sessionFile?: string }
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
  | { id: number; cmd: "compact" }
  /** Hand the current task to a stronger model ("provider/id"). */
  | { id: number; cmd: "escalate"; model: string; reason: string }
  | { id: number; cmd: "checkpoint_restore"; checkpoint: string }
  | { id: number; cmd: "dispose" };

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
  sampling?: Partial<SamplingConfig>;
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
  | { role: "assistant"; parts: HistoryPart[] };

/** Summary of a persisted pi session (from SessionManager.list). */
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
  | { kind: "queue"; steering: number; followUp: number }
  | { kind: "usage"; usage: Usage }
  | { kind: "guard"; label: string }
  /** The hard guards gave up — the UI offers escalation. */
  | { kind: "stuck"; label: string; suggest: string }
  /** Files a run changed, restorable to the snapshot taken when it started. */
  | { kind: "checkpoint"; checkpoint: string; files: string[] }
  | { kind: "perf"; perf: Perf }
  | { kind: "mode"; mode: PermissionMode }
  | { kind: "approval_request"; toolCallId: string; toolName: string; args: unknown }
  | { kind: "approval_done"; toolCallId: string; decision: ApprovalDecision }
  | { kind: "status"; busy: boolean };

export type SidecarOut =
  | { id: number; cmd?: CommandName; ok: true; result?: unknown }
  | { id: number; cmd?: CommandName; ok: false; error: string }
  | { event: PiEvent };
