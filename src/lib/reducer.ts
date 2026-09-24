import type { HistoryItem, PiEvent, SessionSummary } from "../../shared/protocol";

export interface ToolItem {
  id: string;
  name: string;
  args: unknown;
  status: "running" | "ok" | "error";
  summary: string;
}

export type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; thinking: string; text: string; tools: ToolItem[]; open: boolean };

export interface State {
  messages: Msg[];
  busy: boolean;
  model: string;
  cwd: string;
  sessionId: string;
  connected: boolean;
  sessions: SessionSummary[];
  loadingSessions: boolean;
  settledCount: number;
  error: string | null;
}

export type Action =
  | { type: "user"; text: string }
  | { type: "event"; event: PiEvent }
  | { type: "sessions"; sessions: SessionSummary[]; loading: boolean }
  | { type: "history"; items: HistoryItem[] }
  | { type: "connected"; ok: boolean }
  | { type: "clear" }
  | { type: "error"; error: string | null };

export const initialState: State = {
  messages: [],
  busy: false,
  model: "",
  cwd: "",
  sessionId: "",
  connected: false,
  sessions: [],
  loadingSessions: false,
  settledCount: 0,
  error: null,
};

export function withOpenAssistant(messages: Msg[]): Msg[] {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant" && last.open) return messages;
  return [...messages, { role: "assistant", thinking: "", text: "", tools: [], open: true }];
}

function appendToOpen(messages: Msg[], part: { text?: string; thinking?: string }): Msg[] {
  const opened = withOpenAssistant(messages);
  const last = opened[opened.length - 1];
  if (last.role !== "assistant") return messages;
  return [
    ...opened.slice(0, -1),
    { ...last, text: last.text + (part.text ?? ""), thinking: last.thinking + (part.thinking ?? "") },
  ];
}

function toolsInOpen(messages: Msg[], fn: (tools: ToolItem[]) => ToolItem[]): Msg[] {
  const opened = withOpenAssistant(messages);
  const last = opened[opened.length - 1];
  if (last.role !== "assistant") return messages;
  return [...opened.slice(0, -1), { ...last, tools: fn(last.tools) }];
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "user":
      return { ...state, messages: [...state.messages, { role: "user", text: action.text }], busy: true };
    case "sessions":
      return { ...state, sessions: action.sessions, loadingSessions: action.loading };
    case "history":
      return {
        ...state,
        messages: action.items.map((i) =>
          i.role === "user"
            ? { role: "user", text: i.text }
            : { role: "assistant", thinking: i.thinking, text: i.text, tools: i.tools, open: false },
        ),
      };
    case "connected":
      return { ...state, connected: action.ok };
    case "clear":
      return { ...state, messages: [], error: null };
    case "error":
      return { ...state, error: action.error, busy: action.error ? false : state.busy };
    case "event": {
      const e = action.event;
      switch (e.kind) {
        case "init_done":
          return { ...state, model: e.model, cwd: e.cwd, sessionId: e.sessionId, connected: true };
        case "text_delta":
          return { ...state, messages: appendToOpen(state.messages, { text: e.delta }) };
        case "thinking_delta":
          return { ...state, messages: appendToOpen(state.messages, { thinking: e.delta }) };
        case "tool_start":
          return {
            ...state,
            messages: toolsInOpen(state.messages, (tools) => [
              ...tools,
              { id: e.toolCallId, name: e.toolName, args: e.args, status: "running", summary: "" },
            ]),
          };
        case "tool_update":
          return {
            ...state,
            messages: toolsInOpen(state.messages, (tools) =>
              tools.map((t) => (t.id === e.toolCallId ? { ...t, summary: String(e.partialResult ?? t.summary) } : t)),
            ),
          };
        case "tool_end":
          return {
            ...state,
            messages: toolsInOpen(state.messages, (tools) =>
              tools.map((t) =>
                t.id === e.toolCallId ? { ...t, status: e.result.isError ? "error" : "ok", summary: e.result.text } : t,
              ),
            ),
          };
        case "settled":
          return {
            ...state,
            settledCount: state.settledCount + 1,
            busy: false,
            messages: state.messages.map((m) => (m.role === "assistant" ? { ...m, open: false } : m)),
          };
        default:
          return state;
      }
      return state; // unreachable — PiEvent union is exhaustive
    }
    default:
      return state;
  }
}

