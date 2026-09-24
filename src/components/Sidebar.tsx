import { useMemo, useState, type RefObject } from "react";
import { Logo } from "./Logo";
import { PanelLeftClose, Search, Settings, SquarePen } from "lucide-react";
import type { SessionSummary } from "../../shared/protocol";
import { basename, groupSessions, relativeTime, sessionTitle } from "../lib/format";

export function Sidebar({
  sessions,
  loading,
  activePath,
  busyPath,
  onOpen,
  onNew,
  onCollapse,
  onSettings,
  searchRef,
  user,
}: {
  sessions: SessionSummary[];
  loading: boolean;
  activePath: string;
  busyPath: string;
  onOpen: (path: string) => void;
  onNew: () => void;
  onCollapse: () => void;
  onSettings: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
  user: string;
}) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? sessions.filter((s) => `${sessionTitle(s)} ${s.cwd}`.toLowerCase().includes(q))
      : sessions;
    return groupSessions(filtered);
  }, [sessions, query]);

  return (
    <aside className="sidebar">
      <div className="side-top" data-tauri-drag-region>
        <div className="brand">
          <Logo size={22} className="brand-mark" />
          <span className="brand-name">Pi</span>
          <span className="brand-tag">Code</span>
        </div>
        <button className="icon-btn" onClick={onCollapse} title="Zwiń panel (Ctrl+B)">
          <PanelLeftClose size={16} />
        </button>
      </div>

      <button className="new-btn" onClick={onNew} title="Nowa sesja (Ctrl+N)">
        <SquarePen size={15} />
        <span>Nowa sesja</span>
        <kbd>Ctrl N</kbd>
      </button>

      <label className="search">
        <Search size={14} />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          placeholder="Szukaj sesji"
        />
      </label>

      <nav className="session-list">
        {groups.map((g) => (
          <section key={g.label} className="s-group">
            <div className="side-label">{g.label}</div>
            {g.items.map((s) => {
              const active = s.path === activePath;
              return (
                <button
                  key={s.path}
                  className={`session ${active ? "active" : ""}`}
                  onClick={() => !active && onOpen(s.path)}
                  title={`${sessionTitle(s)}\n${s.cwd}`}
                >
                  <span className="s-title">
                    {s.path === busyPath && <span className="s-busy" />}
                    <span className="s-text">{sessionTitle(s)}</span>
                  </span>
                  <span className="s-meta">
                    <span className="s-proj">{basename(s.cwd) || "—"}</span>
                    <span className="s-time">{relativeTime(s.modified)}</span>
                  </span>
                </button>
              );
            })}
          </section>
        ))}
        {loading && sessions.length === 0 && <div className="s-empty">wczytywanie…</div>}
        {!loading && groups.length === 0 && (
          <div className="s-empty">{query ? "nic nie pasuje" : "brak sesji"}</div>
        )}
      </nav>

      <div className="side-footer">
        <span className="avatar">{(user || "?").charAt(0).toUpperCase()}</span>
        <span className="who">
          <span className="who-name">{user || "…"}</span>
          <span className="who-sub">pi · lokalnie</span>
        </span>
        <button className="icon-btn" onClick={onSettings} title="Ustawienia (Ctrl+,)">
          <Settings size={16} />
        </button>
      </div>
    </aside>
  );
}
