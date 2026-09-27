import { Folder, Plus } from "lucide-react";
import type { SessionSummary } from "../../shared/protocol";
import { plural, t } from "../../shared/i18n";
import { basename, recentProjects, relativeTime, sessionTitle } from "../lib/format";

/** Welcome screen: the last few projects, each opening its newest chat (or a new one with +). */
export function RecentProjects({
  sessions,
  current,
  onOpen,
  onNew,
}: {
  sessions: SessionSummary[];
  current: string;
  onOpen: (path: string) => void;
  onNew: (cwd: string) => void;
}) {
  const projects = recentProjects(sessions);
  if (projects.length === 0) return null;
  return (
    <div className="recent">
      <div className="recent-head">{t("Ostatnie projekty")}</div>
      <div className="recent-grid">
        {projects.map((p) => (
          <div key={p.cwd} className={`recent-tile ${p.cwd === current ? "current" : ""}`}>
            <button className="recent-open" onClick={() => onOpen(p.last.path)} title={t("Otwórz ostatnią sesję w {path}", { path: p.cwd })}>
              <span className="recent-name">
                <Folder size={13} />
                <span>{basename(p.cwd)}</span>
              </span>
              <span className="recent-session">{sessionTitle(p.last)}</span>
              <span className="recent-meta">
                {relativeTime(p.last.modified)} · {plural(p.sessions, ["{n} sesja", "{n} sesje", "{n} sesji"], ["{n} chat", "{n} chats"])}
              </span>
            </button>
            <button className="recent-new icon-btn" onClick={() => onNew(p.cwd)} title={t("Nowa sesja w tym projekcie")}>
              <Plus size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
