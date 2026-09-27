import type { SessionSummary, SidebarGroup, SidebarState } from "../../shared/protocol";
import { t } from "../../shared/i18n";

/** Sidebar layout edits: pure, so the UI can apply them optimistically and send the result. */

export function newGroupId(): string {
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Put a session into a group (null = back to the normal list); it leaves any other group. */
export function moveToGroup(state: SidebarState, path: string, groupId: string | null): SidebarState {
  return {
    ...state,
    groups: state.groups.map((g) => {
      const rest = g.sessions.filter((p) => p !== path);
      return { ...g, sessions: g.id === groupId ? [...rest, path] : rest };
    }),
  };
}

export function createGroup(state: SidebarState, name: string, id = newGroupId(), withSession?: string): SidebarState {
  const group: SidebarGroup = { id, name: name.trim() || t("Nowa grupa"), sessions: [] };
  const next = { ...state, groups: [...state.groups, group] };
  return withSession ? moveToGroup(next, withSession, id) : next;
}

export function renameGroup(state: SidebarState, id: string, name: string): SidebarState {
  const n = name.trim();
  return n ? { ...state, groups: state.groups.map((g) => (g.id === id ? { ...g, name: n } : g)) } : state;
}

/** Deleting a group keeps its chats — they return to the normal list. */
export function deleteGroup(state: SidebarState, id: string): SidebarState {
  return { ...state, groups: state.groups.filter((g) => g.id !== id) };
}

export function addProject(state: SidebarState, cwd: string): SidebarState {
  return state.projects.includes(cwd) ? state : { ...state, projects: [...state.projects, cwd] };
}

export function removeProject(state: SidebarState, cwd: string): SidebarState {
  return { ...state, projects: state.projects.filter((p) => p !== cwd) };
}

export function groupOf(state: SidebarState, path: string): SidebarGroup | undefined {
  return state.groups.find((g) => g.sessions.includes(path));
}

export type ProjectEntry = { cwd: string; sessions: SessionSummary[]; latest: string; added: boolean };

/**
 * Sessions by project folder, most recently active first; added projects without
 * any session yet come last, in the order they were added.
 */
export function projectEntries(sessions: SessionSummary[], added: string[]): ProjectEntry[] {
  const byCwd = new Map<string, ProjectEntry>();
  for (const s of sessions) {
    const cwd = s.cwd || "—";
    const e = byCwd.get(cwd) ?? { cwd, sessions: [], latest: "", added: added.includes(cwd) };
    e.sessions.push(s);
    if (s.modified > e.latest) e.latest = s.modified;
    byCwd.set(cwd, e);
  }
  const active = [...byCwd.values()].sort((a, b) => b.latest.localeCompare(a.latest));
  const empty = added.filter((cwd) => !byCwd.has(cwd)).map((cwd) => ({ cwd, sessions: [], latest: "", added: true }));
  return [...active, ...empty];
}
