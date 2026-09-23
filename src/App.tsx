import { useEffect, useReducer, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createWsTransport, type PiTransport } from "./lib/transport";
import type { PiEvent } from "../shared/protocol";

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
  connected: boolean;
  error: string | null;
}

type Action =
  | { type: "user"; text: string }
  | { type: "event"; event: PiEvent }
  | { type: "busy"; busy: boolean }
  | { type: "meta"; model: string; cwd: string }
  | { type: "connected"; ok: boolean }
  | { type: "error"; error: string | null };

function withOpenAssistant(messages: Msg[]): Msg[] {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant" && last.open) return messages;
  return [...messages, { role: "assistant", thinking: "", text: "", tools: [], open: true }];
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "user":
      return {
        ...state,
        messages: [...state.messages, { role: "user", text: action.text }],
        busy: true,
      };
    case "event": {
      const e = action.event;
      switch (e.kind) {
        case "init_done":
          return { ...state, model: e.model, cwd: e.cwd, connected: true };
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
      return state; // unreachable: all event kinds return above
    }
    case "busy":
      return { ...state, busy: action.busy };
    case "meta":
      return { ...state, model: action.model, cwd: action.cwd };
    case "connected":
      return { ...state, connected: action.ok };
    case "error":
      return { ...state, error: action.error, busy: action.error ? false : state.busy };
    default:
      return state;
  }
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

export default function App() {
  const [state, dispatch] = useReducer(reducer, {
    messages: [],
    busy: false,
    model: "",
    cwd: "",
    connected: false,
    error: null,
  });
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const transportRef = useRef<PiTransport | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const cwd = params.get("cwd") ?? undefined;
    const transport = createWsTransport("ws://127.0.0.1:9876");
    transportRef.current = transport;
    const off = transport.onMessage((msg) => {
      if ("event" in msg) dispatch({ type: "event", event: msg.event });
      else if (!msg.ok && "id" in msg && (msg as { cmd?: string }).cmd === undefined) {
        // command reply with error (prompt failures surface here)
      }
    });
    transport.send({ cmd: "init", cwd });
    return () => {
      off();
      transport.close();
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [state.messages]);

  const send = () => {
    const text = input.trim();
    if (!text || !state.connected) return;
    const t = transportRef.current;
    if (!t) return;
    setInput("");
    dispatch({ type: "user", text });
    t.send({ cmd: "prompt", text, behavior: state.busy ? "steer" : undefined });
  };

  const stop = () => transportRef.current?.send({ cmd: "abort" });

  return (
    <div className="app">
      <header className="topbar">
        <span className="dot" data-on={state.connected} />
        <span className="model">{state.model || "pi"}</span>
        {state.cwd && <span className="cwd">{state.cwd}</span>}
      </header>

      <div className="scroll" ref={scrollRef}>
        <div className="column">
          {state.messages.map((m, i) => (
            <Message key={i} msg={m} />
          ))}
          {state.error && <div className="error">{state.error}</div>}
        </div>
      </div>

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
            placeholder={state.busy ? "Napisz, aby sterować bieżącym uruchomieniem… (Enter)" : "Napisz wiadomość… (Enter, Shift+Enter = nowa linia)"}
            rows={1}
            autoFocus
          />
          {state.busy ? (
            <button className="send stop" onClick={stop} title="Przerwij">
              ■
            </button>
          ) : (
            <button className="send" onClick={send} disabled={!state.connected || !input.trim()} title="Wyślij">
              ↑
            </button>
          )}
        </div>
        <div className="hint">
          {state.busy ? "model pracuje — Enter wyśle steering, ■ zatrzyma" : "pi działa lokalnie (llama-server)"}
        </div>
      </footer>
    </div>
  );
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
