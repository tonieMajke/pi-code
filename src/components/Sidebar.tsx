import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Logo } from "./Logo";
import {
  ChevronRight,
  Folder,
  FolderPlus,
  FolderInput,
  FolderMinus,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Settings,
  SquarePen,
  Trash2,
  Layers,
  BarChart3,
  Square,
} from "lucide-react";
import type { SessionStatus } from "../../shared/protocol";
import { t } from "../../shared/i18n";
import type { SessionSummary, SidebarState } from "../../shared/protocol";
import { basename, groupSessions, relativeTime, sessionTitle } from "../lib/format";
import { createGroup, deleteGroup, groupOf, moveToGroup, newGroupId, projectEntries, removeProject, renameGroup } from "../lib/sidebar";

type View = "date" | "projects";
const VIEW_KEY = "pi-gui.sidebar.view";
const COLLAPSED_KEY = "pi-gui.sidebar.collapsed";
const DRAG_TYPE = "application/x-pi-session";
/** Newest chats shown per project before "Pokaż wszystkie". */
const PROJECT_PREVIEW = 5;

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — layout lasts until reload */
  }
}

type MenuEntry = { label: string; icon?: ReactNode; danger?: boolean; onSelect: () => void } | { heading: string } | "sep";
type FloatMenu = { x: number; y: number; items: MenuEntry[] };

export function Sidebar({
  sessions,
  loading,
  activePath,
  busyPath,
  statuses = {},
  onStop,
  onOpen,
  onNew,
  onCollapse,
  onSettings,
  onStats,
  searchRef,
  user,
  layout,
  onLayout,
  onNewIn,
  onAddProject,
  onDelete,
}: {
  sessions: SessionSummary[];
  loading: boolean;
  activePath: string;
  busyPath: string;
  /** Sessions kept in memory by path: working in the background, waiting, finished unseen. */
  statuses?: Record<string, SessionStatus>;
  /** Stop a background session's run. */
  onStop?: (path: string) => void;
  onOpen: (path: string) => void;
  onNew: () => void;
  onCollapse: () => void;
  onSettings: () => void;
  onStats?: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
  user: string;
  /** Groups and added projects (kept by the sidecar). */
  layout: SidebarState;
  onLayout: (next: SidebarState) => void;
  /** New session in that project folder. */
  onNewIn: (cwd: string) => void;
  onAddProject: () => void;
  onDelete: (s: SessionSummary) => void;
}) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>(() => load<View>(VIEW_KEY, "date"));
  const [collapsed, setCollapsed] = useState<string[]>(() => load<string[]>(COLLAPSED_KEY, []));
  const [menu, setMenu] = useState<FloatMenu | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  /** Projects showing all their chats instead of the newest few. */
  const [expanded, setExpanded] = useState<string[]>([]);

  const changeView = (v: View) => {
    setView(v);
    save(VIEW_KEY, v);
  };
  const isCollapsed = (key: string) => collapsed.includes(key);
  const toggle = (key: string) => {
    const next = isCollapsed(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key];
    setCollapsed(next);
    save(COLLAPSED_KEY, next);
  };

  const q = query.trim().toLowerCase();
  const matches = (s: SessionSummary) => !q || `${sessionTitle(s)} ${s.cwd}`.toLowerCase().includes(q);
  const byPath = useMemo(() => new Map(sessions.map((s) => [s.path, s])), [sessions]);
  const grouped = useMemo(() => new Set(layout.groups.flatMap((g) => g.sessions)), [layout]);
  // Grouped chats live only in their group; the rest fill the date / project view.
  const loose = sessions.filter((s) => !grouped.has(s.path) && matches(s));
  const groups = layout.groups.map((g) => ({
    ...g,
    items: g.sessions.map((p) => byPath.get(p)).filter((s): s is SessionSummary => !!s && matches(s)),
  }));

  const newGroup = (withSession?: string) => {
    const id = newGroupId();
    onLayout(createGroup(layout, "Nowa grupa", id, withSession));
    setEditing(id);
  };

  const sessionMenu = (s: SessionSummary, x: number, y: number) => {
    const current = groupOf(layout, s.path);
    const targets = layout.groups.filter((g) => g.id !== current?.id);
    setMenu({
      x,
      y,
      items: [
        { heading: "Przenieś do grupy" },
        ...targets.map((g) => ({ label: g.name, icon: <Layers size={14} />, onSelect: () => onLayout(moveToGroup(layout, s.path, g.id)) })),
        { label: "Nowa grupa…", icon: <Plus size={14} />, onSelect: () => newGroup(s.path) },
        ...(current
          ? [{ label: `Usuń z grupy „${current.name}”`, icon: <FolderMinus size={14} />, onSelect: () => onLayout(moveToGroup(layout, s.path, null)) }]
          : []),
        "sep" as const,
        { label: "Usuń czat…", icon: <Trash2 size={14} />, danger: true, onSelect: () => onDelete(s) },
      ],
    });
  };

  const row = (s: SessionSummary, showProject: boolean) => {
    const active = s.path === activePath;
    return (
      <div
        key={s.path}
        className={`session ${active ? "active" : ""} ${showProject ? "" : "compact"}`}
        role="button"
        tabIndex={0}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, s.path);
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={() => !active && onOpen(s.path)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !active) onOpen(s.path);
          if (e.key === "Delete") onDelete(s);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          sessionMenu(s, e.clientX, e.clientY);
        }}
        title={`${sessionTitle(s)}\n${s.cwd}`}
      >
        <span className="s-title">
          <StatusMark status={s.path === busyPath ? "working" : active ? undefined : statuses[s.path]} />
          <span className="s-text">{sessionTitle(s)}</span>
          {!showProject && <span className="s-time">{relativeTime(s.modified)}</span>}
          {!active && onStop && ["working", "slot", "approval"].includes(statuses[s.path] ?? "") && (
            <button
              className="s-stop icon-btn"
              title={t("Zatrzymaj sesję w tle")}
              onClick={(e) => {
                e.stopPropagation();
                onStop(s.path);
              }}
            >
              <Square size={11} />
            </button>
          )}
          <button
            className="s-more icon-btn"
            title="Więcej"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              sessionMenu(s, r.left, r.bottom + 4);
            }}
          >
            <MoreHorizontal size={14} />
          </button>
        </span>
        {showProject && (
          <span className="s-meta">
            <span className="s-proj">{basename(s.cwd) || "—"}</span>
            <span className="s-time">{relativeTime(s.modified)}</span>
          </span>
        )}
      </div>
    );
  };

  /** Collapsible header; groups also take dropped chats. */
  const header = (
    key: string,
    label: ReactNode,
    opts: { icon: ReactNode; count?: number; actions?: ReactNode; dropGroup?: string; title?: string },
  ) => (
    <div
      className={`s-head ${dropTarget === key ? "drop" : ""}`}
      title={opts.title}
      onDragOver={
        opts.dropGroup
          ? (e) => {
              if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
              e.preventDefault();
              setDropTarget(key);
            }
          : undefined
      }
      onDragLeave={() => setDropTarget((t) => (t === key ? null : t))}
      onDrop={
        opts.dropGroup
          ? (e) => {
              e.preventDefault();
              setDropTarget(null);
              const path = e.dataTransfer.getData(DRAG_TYPE);
              if (path) onLayout(moveToGroup(layout, path, opts.dropGroup!));
            }
          : undefined
      }
    >
      <button className="s-head-toggle" onClick={() => toggle(key)}>
        <ChevronRight size={13} className={`s-chev ${isCollapsed(key) ? "" : "open"}`} />
        {opts.icon}
        <span className="s-head-label">{label}</span>
        {opts.count !== undefined && <span className="s-count">{opts.count}</span>}
      </button>
      {opts.actions}
    </div>
  );

  const dateGroups = groupSessions(loose);
  const projects = projectEntries(loose, layout.projects).filter((p) => !q || p.sessions.length || p.cwd.toLowerCase().includes(q));
  const nothing = loose.length === 0 && groups.every((g) => g.items.length === 0) && (view === "date" || projects.length === 0);

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

      <div className="side-tabs">
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={view === "date"} className={view === "date" ? "on" : ""} onClick={() => changeView("date")}>
            Czaty
          </button>
          <button
            role="tab"
            aria-selected={view === "projects"}
            className={view === "projects" ? "on" : ""}
            onClick={() => changeView("projects")}
          >
            Projekty
          </button>
        </div>
        <button className="icon-btn" title="Nowa grupa" onClick={() => newGroup()}>
          <Layers size={15} />
        </button>
        <button
          className="icon-btn"
          title="Dodaj projekt (folder)"
          onClick={() => {
            changeView("projects");
            onAddProject();
          }}
        >
          <FolderPlus size={15} />
        </button>
      </div>

      <nav className="session-list">
        {groups.map((g) =>
          q && g.items.length === 0 ? null : (
            <section key={g.id} className="s-group user-group">
              {editing === g.id ? (
                <GroupNameInput
                  initial={g.name}
                  onDone={(name) => {
                    setEditing(null);
                    if (name !== null) onLayout(renameGroup(layout, g.id, name));
                  }}
                />
              ) : (
                header(`group:${g.id}`, g.name, {
                  icon: <Layers size={13} />,
                  count: g.items.length,
                  dropGroup: g.id,
                  title: "Przeciągnij tu czat, żeby dodać go do grupy",
                  actions: (
                    <button
                      className="icon-btn s-head-act"
                      title="Grupa"
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        setMenu({
                          x: r.left,
                          y: r.bottom + 4,
                          items: [
                            { label: "Zmień nazwę", icon: <Pencil size={14} />, onSelect: () => setEditing(g.id) },
                            {
                              label: "Usuń grupę (czaty zostają)",
                              icon: <Trash2 size={14} />,
                              danger: true,
                              onSelect: () => onLayout(deleteGroup(layout, g.id)),
                            },
                          ],
                        });
                      }}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  ),
                })
              )}
              {!isCollapsed(`group:${g.id}`) &&
                (g.items.length ? (
                  g.items.map((s) => row(s, true))
                ) : (
                  <div className="s-empty small">Przeciągnij tu czat albo użyj „⋯” przy czacie.</div>
                ))}
            </section>
          ),
        )}

        {view === "date" &&
          dateGroups.map((g) => (
            <section key={g.label} className="s-group">
              <div className="side-label">{g.label}</div>
              {g.items.map((s) => row(s, true))}
            </section>
          ))}

        {view === "projects" &&
          projects.map((p) => (
            <section key={p.cwd} className="s-group">
              {header(`proj:${p.cwd}`, basename(p.cwd) || p.cwd, {
                icon: <Folder size={13} />,
                count: p.sessions.length,
                title: p.cwd,
                actions: (
                  <>
                    <button className="icon-btn s-head-act" title={`Nowa sesja w ${basename(p.cwd)}`} onClick={() => onNewIn(p.cwd)}>
                      <Plus size={14} />
                    </button>
                    {p.added && (
                      <button
                        className="icon-btn s-head-act"
                        title="Projekt"
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          setMenu({
                            x: r.left,
                            y: r.bottom + 4,
                            items: [
                              {
                                label: "Usuń z listy projektów (czaty zostają)",
                                icon: <FolderInput size={14} />,
                                onSelect: () => onLayout(removeProject(layout, p.cwd)),
                              },
                            ],
                          });
                        }}
                      >
                        <MoreHorizontal size={14} />
                      </button>
                    )}
                  </>
                ),
              })}
              {!isCollapsed(`proj:${p.cwd}`) &&
                (p.sessions.length ? (
                  <>
                    {(q || expanded.includes(p.cwd) ? p.sessions : p.sessions.slice(0, PROJECT_PREVIEW)).map((s) => row(s, false))}
                    {!q && p.sessions.length > PROJECT_PREVIEW && (
                      <button
                        className="s-more-link"
                        onClick={() => setExpanded((e) => (e.includes(p.cwd) ? e.filter((c) => c !== p.cwd) : [...e, p.cwd]))}
                      >
                        {expanded.includes(p.cwd) ? "Pokaż mniej" : `Pokaż wszystkie (${p.sessions.length})`}
                      </button>
                    )}
                  </>
                ) : (
                  <div className="s-empty small">Brak czatów — „+” zaczyna pierwszy.</div>
                ))}
            </section>
          ))}

        {loading && sessions.length === 0 && <div className="s-empty">wczytywanie…</div>}
        {!loading && nothing && <div className="s-empty">{query ? "nic nie pasuje" : "brak sesji"}</div>}
      </nav>

      <div className="side-footer">
        <span className="avatar">{(user || "?").charAt(0).toUpperCase()}</span>
        <span className="who">
          <span className="who-name">{user || "…"}</span>
          <span className="who-sub">pi · lokalnie</span>
        </span>
        {onStats && (
          <button className="icon-btn" onClick={onStats} title={t("Statystyki modeli")}>
            <BarChart3 size={16} />
          </button>
        )}
        <button className="icon-btn" onClick={onSettings} title="Ustawienia (Ctrl+,)">
          <Settings size={16} />
        </button>
      </div>

      {menu && <FloatingMenu menu={menu} onClose={() => setMenu(null)} />}
    </aside>
  );
}

function GroupNameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  // Enter/Esc and the blur that follows must not both fire.
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      ref={ref}
      className="s-group-input"
      value={value}
      aria-label="Nazwa grupy"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(value);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(value)}
    />
  );
}

/** Context menu at a point (right-click or "⋯"); closes on outside click, Esc or scroll. */
function FloatingMenu({ menu, onClose }: { menu: FloatMenu; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });
  useEffect(() => {
    // Keep it on screen.
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)),
      top: menu.y + r.height > window.innerHeight - 8 ? Math.max(8, menu.y - r.height) : menu.y,
    });
  }, [menu]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    document.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
      document.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="menu-pop float-menu" role="menu" style={pos}>
      {menu.items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="menu-sep" />
        ) : "heading" in it ? (
          <div key={i} className="menu-title">
            {it.heading}
          </div>
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`menu-item ${it.danger ? "danger" : ""}`}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            {it.icon}
            <span className="menu-label">{it.label}</span>
          </button>
        ),
      )}
    </div>
  );
}

const MARK_TITLES: Record<SessionStatus, string> = {
  working: t("pracuje"),
  slot: t("czeka na slot — model zajęty przez inną sesję"),
  approval: t("czeka na zgodę"),
  done: t("skończyła — jeszcze nie widziana"),
  error: t("skończyła z błędem"),
  idle: "",
};

/** Dot before the title: pulsing = working, hollow = waiting for the model, terracotta = needs you. */
function StatusMark({ status }: { status?: SessionStatus }) {
  if (!status || status === "idle") return null;
  return <span className={status === "working" ? "s-busy" : `s-mark s-${status}`} title={MARK_TITLES[status]} />;
}
