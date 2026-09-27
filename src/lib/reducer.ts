import type {
  Attachment,
  HistoryItem,
  ModelSummary,
  PermissionMode,
  Perf,
  PiEvent,
  SessionSummary,
  ToolStatus,
  UiRequest,
  Usage,
} from "../../shared/protocol";
import { stripMidrunNote } from "../../shared/midrun";

export type { RequestStats } from "../../shared/protocol";
import type { RequestStats } from "../../shared/protocol";
export type LivePerf = Exclude<Perf, { phase: "done" }>;
export type Approval = { toolCallId: string; toolName: string; args: unknown };
export type Outgoing = { text: string; images?: Attachment[] };

export interface ToolItem {
  id: string;
  name: string;
  args: unknown;
  status: ToolStatus;
  summary: string;
  /** What the model saw (screenshots, renders). */
  images?: Attachment[];
  /** ms timestamps; absent for tools restored from history. */
  start?: number;
  end?: number;
}

export type Part =
  | { type: "thinking"; text: string; start?: number; end?: number }
  | { type: "text"; text: string }
  | { type: "tool"; tool: ToolItem }
  | { type: "notice"; text: string };

export type InfoLevel = "info" | "warning" | "error";

export type Msg =
  | { role: "user"; text: string; images?: Attachment[] }
  /** A slash command the user ran (local to the view, not part of the session file). */
  | { role: "command"; text: string }
  /** Output of a command or an extension message (local to the view). */
  | { role: "info"; text: string; level: InfoLevel }
  | {
      role: "assistant";
      parts: Part[];
      open: boolean;
      stats?: RequestStats[];
      /** Files this run changed, restorable to the snapshot taken at its start. */
      checkpoint?: { id: string; files: string[]; restored?: boolean };
    };

export interface State {
  messages: Msg[];
  busy: boolean;
  /** When the current run started (ms) — drives the "working" timer. */
  busySince: number | null;
  model: string;
  provider: string;
  cwd: string;
  branch: string;
  user: string;
  sessionId: string;
  sessionPath: string;
  sessionName: string;
  connected: boolean;
  sessions: SessionSummary[];
  loadingSessions: boolean;
  models: ModelSummary[];
  usage: Usage | null;
  /** Messages sent mid-run, waiting for the SDK to take them off its queue. */
  pending: Outgoing[];
  mode: PermissionMode;
  /** Tool calls parked on the permission gate, oldest first. */
  approvals: Approval[];
  /** Questions from pi extensions (ctx.ui select/confirm/input/editor), oldest first. */
  dialogs: UiRequest[];
  /** The hard guards gave up on the last run. */
  stuck: { label: string; suggest: string } | null;
  /** Speed of the request in flight (cleared when it completes). */
  perf: LivePerf | null;
  settledCount: number;
  error: string | null;
  /** The active session was handed to a real pi terminal: the composer must not write to it. */
  terminalOpen: boolean;
}

export type Action =
  | { type: "user"; text: string; images?: Attachment[]; at?: number }
  /** A slash command; run = pi executes it (the view waits for "settled"). */
  | { type: "command"; text: string; run?: boolean; at?: number }
  | { type: "info"; text: string; level?: InfoLevel }
  | { type: "dialog_done"; id: string }
  | { type: "event"; event: PiEvent; at?: number }
  | { type: "sessions"; sessions: SessionSummary[]; loading: boolean }
  | { type: "models"; models: ModelSummary[] }
  | { type: "history"; items: HistoryItem[] }
  | { type: "connected"; ok: boolean }
  | { type: "clear" }
  | { type: "restored"; checkpoint: string }
  | { type: "unstuck" }
  | { type: "error"; error: string | null };

export const initialState: State = {
  messages: [],
  busy: false,
  busySince: null,
  model: "",
  provider: "",
  cwd: "",
  branch: "",
  user: "",
  sessionId: "",
  sessionPath: "",
  sessionName: "",
  connected: false,
  sessions: [],
  loadingSessions: true,
  models: [],
  usage: null,
  pending: [],
  mode: "ask",
  approvals: [],
  dialogs: [],
  stuck: null,
  perf: null,
  settledCount: 0,
  error: null,
  terminalOpen: false,
};

type Assistant = Extract<Msg, { role: "assistant" }>;

export function withOpenAssistant(messages: Msg[]): Msg[] {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant" && last.open) return messages;
  return [...messages, { role: "assistant", parts: [], open: true }];
}

/** Apply fn to the open assistant turn (creating it if needed). */
function updateOpen(messages: Msg[], fn: (a: Assistant) => Assistant): Msg[] {
  const opened = withOpenAssistant(messages);
  const last = opened[opened.length - 1] as Assistant;
  return [...opened.slice(0, -1), fn(last)];
}

/** Close a trailing, still-running thinking block (something else started). */
function closeThinking(parts: Part[], at: number | undefined): Part[] {
  const last = parts[parts.length - 1];
  if (last?.type === "thinking" && last.end === undefined) {
    return [...parts.slice(0, -1), { ...last, end: at ?? last.start }];
  }
  return parts;
}

function appendText(parts: Part[], kind: "text" | "thinking", delta: string, at: number | undefined): Part[] {
  const last = parts[parts.length - 1];
  if (last && last.type === kind) {
    return [...parts.slice(0, -1), { ...last, text: last.text + delta }];
  }
  const base = kind === "text" ? closeThinking(parts, at) : parts;
  return [...base, kind === "text" ? { type: "text", text: delta } : { type: "thinking", text: delta, start: at }];
}

/** Update a tool wherever it lives — a steering message may have opened a newer turn. */
function mapTool(messages: Msg[], id: string, fn: (t: ToolItem) => ToolItem): Msg[] {
  return messages.map((m) =>
    m.role === "assistant" && m.parts.some((p) => p.type === "tool" && p.tool.id === id)
      ? { ...m, parts: m.parts.map((p) => (p.type === "tool" && p.tool.id === id ? { ...p, tool: fn(p.tool) } : p)) }
      : m,
  );
}

/** Move the first n pending messages into the transcript (the SDK consumed them). */
function flushPending(state: State, n: number, at: number | undefined): State {
  if (n <= 0) return state;
  const taken = state.pending.slice(0, n);
  const closed = state.messages.map((m) =>
    m.role === "assistant" && m.open ? { ...m, open: false, parts: closeThinking(m.parts, at) } : m,
  );
  return {
    ...state,
    pending: state.pending.slice(n),
    messages: [...closed, ...taken.map((o): Msg => userMsg(o.text, o.images))],
  };
}

/** Request timings belong to the latest assistant turn (the request that produced it). */
function attachStats(messages: Msg[], stats: RequestStats): Msg[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      return [...messages.slice(0, i), { ...m, stats: [...(m.stats ?? []), stats] }, ...messages.slice(i + 1)];
    }
  }
  return messages;
}

function historyMessages(items: HistoryItem[]): Msg[] {
  return items.map((i): Msg =>
    i.role === "user"
      ? userMsg(i.text, i.images)
      : {
          role: "assistant",
          open: false,
          parts: i.parts.map((p): Part => (p.type === "tool" ? { type: "tool", tool: { ...p.tool } } : p)),
          ...(i.stats?.length ? { stats: i.stats } : {}),
        },
  );
}

function userMsg(raw: string, images?: Attachment[]): Msg {
  const text = stripMidrunNote(raw);
  return images?.length ? { role: "user", text, images } : { role: "user", text };
}

/** Close a turn at run end; a tool still "running" was cut off without tool_end. */
function settleTurn(m: Assistant, at: number | undefined): Assistant {
  const running = m.parts.some((p) => p.type === "tool" && p.tool.status === "running");
  if (!m.open && !running) return m;
  return {
    ...m,
    open: false,
    parts: closeThinking(m.parts, at).map((p) =>
      p.type === "tool" && p.tool.status === "running"
        ? { ...p, tool: { ...p.tool, status: "error", summary: p.tool.summary || "przerwano", end: at } }
        : p,
    ),
  };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "user":
      // Mid-run messages are queued by the SDK; they join the transcript when consumed.
      if (state.busy) return { ...state, pending: [...state.pending, { text: action.text, images: action.images }] };
      return {
        ...state,
        messages: [...state.messages, userMsg(action.text, action.images)],
        busy: true,
        busySince: action.at ?? null,
        error: null,
        stuck: null,
      };
    case "command":
      return {
        ...state,
        messages: [...state.messages, { role: "command", text: action.text }],
        ...(action.run ? { busy: true, busySince: action.at ?? null, error: null } : {}),
      };
    case "info":
      return { ...state, messages: [...state.messages, { role: "info", text: action.text, level: action.level ?? "info" }] };
    case "dialog_done":
      return { ...state, dialogs: state.dialogs.filter((d) => d.id !== action.id) };
    case "sessions":
      return { ...state, sessions: action.sessions, loadingSessions: action.loading };
    case "models":
      return { ...state, models: action.models };
    case "history":
      return { ...state, messages: historyMessages(action.items) };
    case "connected": {
      if (action.ok) return { ...state, connected: true };
      // The sidecar is gone: nothing is running any more and nothing will answer.
      const at = Date.now();
      const flushed = flushPending(state, state.pending.length, at);
      return {
        ...flushed,
        connected: false,
        busy: false,
        busySince: null,
        perf: null,
        approvals: [],
        dialogs: [],
        messages: flushed.messages.map((m) => (m.role === "assistant" ? settleTurn(m, at) : m)),
      };
    }
    case "clear":
      return { ...state, messages: [], error: null, pending: [], approvals: [], dialogs: [], perf: null, stuck: null };
    case "restored":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.role === "assistant" && m.checkpoint?.id === action.checkpoint ? { ...m, checkpoint: { ...m.checkpoint, restored: true } } : m,
        ),
      };
    case "unstuck":
      return { ...state, stuck: null };
    case "error":
      return { ...state, error: action.error };
    case "event": {
      const e = action.event;
      const at = action.at;
      switch (e.kind) {
        case "history": {
          // A session being opened: its transcript replaces whatever was on screen. A session
          // brought back from the background mid-run keeps working: its last turn stays open.
          const messages = historyMessages(e.items);
          const last = messages[messages.length - 1];
          if (e.busy && last?.role === "assistant") messages[messages.length - 1] = { ...last, open: true };
          return {
            ...state,
            messages,
            busy: e.busy ?? false,
            busySince: e.busy ? (e.since ?? action.at ?? null) : null,
            sessionPath: e.sessionPath,
            error: null,
            pending: [],
            approvals: [],
            dialogs: [],
            perf: null,
            stuck: null,
          };
        }
        case "init_done":
          return {
            ...state,
            // A different session without a history event first (new, fork, handoff): the old
            // one's run — maybe still going on in the background — is not this view's any more.
            ...(e.sessionPath !== state.sessionPath || !e.sessionPath
              ? e.sessionId !== state.sessionId
                ? { busy: false, busySince: null, perf: null, approvals: [], dialogs: [], pending: [] }
                : {}
              : {}),
            model: e.model,
            provider: e.provider,
            cwd: e.cwd,
            branch: e.branch,
            user: e.user,
            sessionId: e.sessionId,
            sessionPath: e.sessionPath,
            sessionName: e.sessionName,
            mode: e.mode,
            connected: true,
          };
        case "text_delta":
          return { ...state, messages: updateOpen(state.messages, (a) => ({ ...a, parts: appendText(a.parts, "text", e.delta, at) })) };
        case "thinking_delta":
          return {
            ...state,
            messages: updateOpen(state.messages, (a) => ({ ...a, parts: appendText(a.parts, "thinking", e.delta, at) })),
          };
        case "tool_start":
          return {
            ...state,
            messages: updateOpen(state.messages, (a) => ({
              ...a,
              parts: [
                ...closeThinking(a.parts, at),
                { type: "tool", tool: { id: e.toolCallId, name: e.toolName, args: e.args, status: "running", summary: "", start: at } },
              ],
            })),
          };
        case "tool_update":
          return {
            ...state,
            messages: mapTool(state.messages, e.toolCallId, (t) => ({ ...t, summary: e.partial || t.summary })),
          };
        case "tool_end":
          return {
            ...state,
            messages: mapTool(state.messages, e.toolCallId, (t) => ({
              ...t,
              status: e.result.isError ? "error" : "ok",
              summary: e.result.text,
              images: e.result.images,
              end: at,
            })),
          };
        case "queue":
          return flushPending(state, state.pending.length - (e.steering + e.followUp), at);
        case "usage":
          return { ...state, usage: e.usage };
        case "stuck":
          return { ...state, stuck: { label: e.label, suggest: e.suggest } };
        case "checkpoint": {
          const i = state.messages.map((m) => m.role).lastIndexOf("assistant");
          if (i < 0) return state;
          const m = state.messages[i] as Assistant;
          return {
            ...state,
            messages: [...state.messages.slice(0, i), { ...m, checkpoint: { id: e.checkpoint, files: e.files } }, ...state.messages.slice(i + 1)],
          };
        }
        case "guard":
          return {
            ...state,
            messages: updateOpen(state.messages, (a) => ({
              ...a,
              parts: [...closeThinking(a.parts, at), { type: "notice", text: e.label }],
            })),
          };
        case "mode":
          return { ...state, mode: e.mode };
        case "terminal_state":
          return { ...state, terminalOpen: e.open };
        case "approval_request":
          return {
            ...state,
            approvals: [...state.approvals, { toolCallId: e.toolCallId, toolName: e.toolName, args: e.args }],
          };
        case "approval_done":
          return { ...state, approvals: state.approvals.filter((a) => a.toolCallId !== e.toolCallId) };
        case "ui_request":
          return { ...state, dialogs: [...state.dialogs, e.request] };
        case "ui_done":
          return { ...state, dialogs: state.dialogs.filter((d) => d.id !== e.id) };
        case "perf": {
          if (e.perf.phase !== "done") return { ...state, perf: e.perf };
          // The critic's and reviewer's requests are counted on the stats page, not under the turn.
          if (e.role && e.role !== "main") return { ...state, perf: null };
          const stats = e.perf;
          return {
            ...state,
            perf: null,
            messages: attachStats(state.messages, stats),
          };
        }
        case "settled": {
          // Anything still pending was dropped by an abort — show it rather than lose it.
          const flushed = flushPending(state, state.pending.length, at);
          return {
            ...flushed,
            settledCount: state.settledCount + 1,
            busy: false,
            busySince: null,
            perf: null,
            approvals: [],
            messages: flushed.messages.map((m) =>
              m.role === "assistant" ? settleTurn(m, at) : m,
            ),
          };
        }
        default:
          return state;
      }
    }
    default:
      return state;
  }
}
