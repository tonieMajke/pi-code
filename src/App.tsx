import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createWsTransport, type PiTransport } from "./lib/transport";
import type { PiEvent, SessionSummary } from "../shared/protocol";

interface ToolItem {
  id: string;
  name: string;
  args: unknown;
  status: "running" | "ok" | "error";
  summary: string;
}

type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; thinking: string; text: string; tools: ToolItem[]; open: boolean };

interface State {
  messages: Msg[];
  busy: boolean;
  model: string;
  cwd: string;
  sessionId: string;
  connected: boolean;
  sessions: SessionSummary[];
  loadingSessions: boolean;
  error: string | null;
}

type Action =
  | { type: "user"; text: string }
  | { type: "event"; event: PiEvent }
  | { type: "sessions"; sessions: SessionSummary[]; loading: boolean }
  | { type: "connected"; ok: boolean }
  | { type: "clear" }
  | { type: "error"; error: string | null };

function withOpenAssistant(messages: Msg[]): Msg[] {
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

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "user":
      return { ...state, messages: [...state.messages, { role: "user", text: action.text }], busy: true };
    case "sessions":
      return { ...state, sessions: action.sessions, loadingSessions: action.loading };
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
          return {
            ...state,
            model: e.model,
            cwd: e.cwd,
            sessionId: e.sessionId,
            connected: true,
          };
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
            busy: false,
            messages: state.messages.map((m) => (m.role === "assistant" ? { ...m, open: false } : m)),
          };
        default:
          return state;
      }
      return state; // unreachable
    }
    default:
      return state;
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, {
    messages: [],
    busy: false,
    model: "",
    cwd: "",
    sessionId: "",
    connected: false,
    sessions: [],
    loadingSessions: false,
    error: null,
  });
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const transportRef = useRef<PiTransport | null>(null);

  const refreshSessions = useCallback(() => {
    const t = transportRef.current;
    if (!t) return;
    dispatch({ type: "sessions", sessions: state.sessions, loading: true });
    t.send({ cmd: "sessions_list" });
    // result arrives via onMessage reply handler below
  }, [state.sessions]);

  useEffect(() => {
    const t = createWsTransport("ws://127.0.0.1:9876");
    transportRef.current = t;
    const off = t.onMessage((msg) => {
      if ("event" in msg) {
        dispatch({ type: "event", event: msg.event });
      } else if (msg.ok && Array.isArray((msg.result ?? []) as unknown[])) {
        // sessions_list reply
        dispatch({ type: "sessions", sessions: msg.result as SessionSummary[], loading: false });
      }
    });
    t.send({ cmd: "init" });
    return () => {
      off();
      t.close();
      transportRef.current = null;
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [state.messages]);

  const send = () => {
    const text = input.trim();
    const t = transportRef.current;
    if (!text || !t) return;
    setInput("");
    dispatch({ type: "user", text });
    t.send({ cmd: "prompt", text, behavior: state.busy ? "steer" : undefined });
  };

  const stop = () => transportRef.current?.send({ cmd: "abort" });

  const newSession = () => {
    dispatch({ type: "clear" });
    transportRef.current?.send({ cmd: "init" });
    refreshSessions();
  };

  const openSession = (path: string) => {
    dispatch({ type: "clear" });
    transportRef.current?.send({ cmd: "session_open", path });
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <button className="new-btn" onClick={newSession}>
          + Nowa
        </button>
        <div className="side-label">Sesje</div>
        <div className="session-list">
          {state.sessions.map((s) => (
            <button
              key={s.path}
              className={`session ${s.path === activePath(state) ? "active" : ""}`}
              onClick={() => openSession(s.path)}
              title={s.cwd}
            >
              <span className="s-dot" />
              <span className="s-title">{s.name || s.firstMessage || s.id.slice(0, 8)}</span>
            </button>
          ))}
          {state.loadingSessions && <div className="s-empty">wczytywanie…</div>}
          {!state.loadingSessions && state.sessions.length === 0 && (
            <div className="s-empty">brak sesji</div>
          )}
        </div>
        <div className="side-footer">
          <span className="chip">
            <span className="avatar">M</span> majke · pi
          </span>
        </div>
      </aside>

      <main className="main">
        {state.messages.length === 0 ? (
          <div className="greeting">
            <h1>Co dalej, Majku?</h1>
            <p className="sub">lokalny pi · {state.model || "—"}</p>
          </div>
        ) : (
          <div className="scroll" ref={scrollRef}>
            <div className="column">
              {state.messages.map((m, i) => (
                <Message key={i} msg={m} />
              ))}
              {state.error && <div className="error">{state.error}</div>}
            </div>
          </div>
        )}

        <footer className="composer">
          <div className="composer-box">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Opisz zadanie albo zadaj pytanie"
              rows={1}
              autoFocus
            />
            {state.busy ? (
              <button className="send stop" onClick={stop} title="Przerwij">■</button>
            ) : (
              <button className="send" onClick={send} disabled={!state.connected || !input.trim()} title="Wyślij">
                ↑
              </button>
            )}
          </div>
          <div className="composer-meta">
            <span className="dot" data-on={state.connected} />
            <span>
              {state.busy ? "model pracuje — Enter = steering" : "pi działa lokalnie (llama-server)"}
            </span>
            <span className="spacer" />
            <span className="model">{state.model || "pi"}</span>
          </div>
        </footer>
      </main>
    </div>
  );
}

function activePath(state: State): string {
  // best-effort: match session by id from init_done
  const s = state.sessions.find((x) => x.id === state.sessionId);
  return s?.path ?? "";
}

function Message({ msg }: { msg: Msg }) {
  if (msg.role === "user") {
    return (
      <div className="msg user">
        <div className="bubble">{msg.text}</div>
      </div>
    );
  }
  return (
    <div className="msg assistant">
      {msg.thinking && <Thinking text={msg.thinking} active={msg.open} />}
      {msg.tools.map((t) => (
        <ToolCard key={t.id} tool={t} />
      ))}
      {msg.text && (
        <div className="md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function Thinking({ text, active }: { text: string; active: boolean }) {
  return (
    <details className="thinking" open={active}>
      <summary>{active ? "myśli…" : "pomyślano"}</summary>
      <pre className="thinking-text">{text}</pre>
    </details>
  );
}

function ToolCard({ tool }: { tool: ToolItem }) {
  const argLine = summarizeArgs(tool.args);
  return (
    <details className={`tool ${tool.status}`} open={tool.status === "running"}>
      <summary>
        {tool.status === "running" && <span className="spinner" />}
        <span className="tool-name">{tool.name}</span>
        {argLine && <span className="tool-args">{argLine}</span>}
        {tool.status === "error" && <span className="tool-err">błąd</span>}
      </summary>
      <pre className="tool-result">{tool.summary || (tool.status === "running" ? "wykonywanie…" : "")}</pre>
    </details>
  );
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const key of ["path", "file", "command", "query", "url"]) {
    const v = a[key];
    if (typeof v === "string") return v.length > 120 ? `${v.slice(0, 120)}…` : v;
  }
  return "";
}
