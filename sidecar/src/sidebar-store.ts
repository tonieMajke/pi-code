import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SidebarState } from "../../shared/protocol.js";
import { t } from "../../shared/i18n.js";

export const EMPTY_SIDEBAR: SidebarState = { groups: [], projects: [] };

/** Keeps only well-formed data: a hand-edited or old file must not break the sidebar. */
export function normalizeSidebar(raw: unknown): SidebarState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x !== ""))] : []);
  const seen = new Set<string>();
  const groups = (Array.isArray(r.groups) ? r.groups : [])
    .map((g) => (g && typeof g === "object" ? (g as Record<string, unknown>) : {}))
    .filter((g) => typeof g.id === "string" && g.id && !seen.has(g.id) && seen.add(g.id))
    .map((g) => ({ id: g.id as string, name: typeof g.name === "string" && g.name.trim() ? g.name.trim() : t("Grupa"), sessions: strings(g.sessions) }));
  // A session belongs to at most one group: the first one keeps it.
  const taken = new Set<string>();
  for (const g of groups) g.sessions = g.sessions.filter((p) => !taken.has(p) && taken.add(p));
  return { groups, projects: strings(r.projects) };
}

/** Sidebar layout (user groups, added projects) in its own file next to pi's settings. */
export class SidebarStore {
  private state: SidebarState;

  constructor(private readonly file: string) {
    try {
      this.state = normalizeSidebar(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      this.state = { ...EMPTY_SIDEBAR };
    }
  }

  get(): SidebarState {
    return this.state;
  }

  set(next: unknown): SidebarState {
    this.state = normalizeSidebar(next);
    mkdirSync(dirname(this.file), { recursive: true });
    // Write-then-rename: a crash mid-write must not lose the user's groups.
    writeFileSync(`${this.file}.tmp`, `${JSON.stringify(this.state, null, 2)}\n`);
    renameSync(`${this.file}.tmp`, this.file);
    return this.state;
  }

  /** A deleted session leaves every group. */
  forget(path: string): void {
    if (this.state.groups.some((g) => g.sessions.includes(path)))
      this.set({ ...this.state, groups: this.state.groups.map((g) => ({ ...g, sessions: g.sessions.filter((p) => p !== path) })) });
  }
}
