import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { initialState, reducer, type Msg, type State } from "./lib/reducer";
import { markdownComponents } from "./lib/code-block";
import { ToolCard } from "./lib/tool-card";
import { createWsTransport, type PiTransport } from "./lib/transport";
import { createTauriTransport, inTauri } from "./lib/tauri";
import type { HistoryItem, SessionSummary } from "../shared/protocol";

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [input, setInput] = useState("");
  const [transportKind, setTransportKind] = useState("…");
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const transportRef = useRef<PiTransport | null>(null);

  const refreshSessions = useCallback(() => {
    const t = transportRef.current;
    if (!t) return;
    t.send({ cmd: "sessions_list" });
  }, []);

  // A run may have created/renamed a session — refresh the sidebar after every settled.
  useEffect(() => {
    if (state.settledCount > 0) refreshSessions();
  }, [state.settledCount, refreshSessions]);

  useEffect(() => {
    // In the Tauri shell the sidecar is spawned by Rust (stdio); in the
    // browser we go through the local WS dev bridge.
    const t: PiTransport = inTauri() ? createTauriTransport() : createWsTransport("ws://127.0.0.1:9876");
    setTransportKind(inTauri() ? "tauri" : "ws");
    transportRef.current = t;
    const off = t.onMessage((msg) => {
      if ("event" in msg) {
        dispatch({ type: "event", event: msg.event });
        return;
      }
      if (!msg.ok || !Array.isArray(msg.result)) return;
      const arr = msg.result as (SessionSummary | HistoryItem)[];
      if (arr.length > 0 && "path" in arr[0]) {
        dispatch({ type: "sessions", sessions: arr as SessionSummary[], loading: false });
      } else if (arr.length > 0 && "role" in arr[0]) {
        dispatch({ type: "history", items: arr as HistoryItem[] });
      }
    });
    const offOpen = t.onOpen(() => {
      // Boot (or re-boot after bridge restart): init is idempotent in the sidecar.
      t.send({ cmd: "init" });
      t.send({ cmd: "history" });
      t.send({ cmd: "sessions_list" });
    });
    return () => {
      off();
      offOpen();
      t.close();
      transportRef.current = null;
    };
  }, []);

  // Autoscroll only while the user is pinned to the bottom (don't fight their scroll).
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTo({ top: el.scrollHeight });
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
    atBottomRef.current = true;
    transportRef.current?.send({ cmd: "session_new" });
    refreshSessions();
  };

  const openSession = (path: string) => {
    dispatch({ type: "clear" });
    atBottomRef.current = true;
    const t = transportRef.current;
    t?.send({ cmd: "session_open", path });
    t?.send({ cmd: "history" });
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
          <div className="scroll" ref={scrollRef} onScroll={onScroll}>
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
            <span className="transport">{transportKind}</span>
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
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {msg.text}
          </ReactMarkdown>
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

