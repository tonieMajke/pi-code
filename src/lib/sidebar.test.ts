import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../shared/protocol";
import { addProject, createGroup, deleteGroup, groupOf, moveToGroup, projectEntries, renameGroup } from "./sidebar";

const empty = { groups: [], projects: [] };
const sess = (path: string, cwd: string, modified: string): SessionSummary => ({
  path,
  id: path,
  cwd,
  modified,
  messageCount: 1,
  firstMessage: path,
});

describe("sidebar layout", () => {
  it("a chat is in at most one group; null takes it out", () => {
    let s = createGroup(empty, "Praca", "g1", "/a");
    s = createGroup(s, "Dom", "g2");
    s = moveToGroup(s, "/a", "g2");
    expect(groupOf(s, "/a")?.id).toBe("g2");
    expect(s.groups[0].sessions).toEqual([]);
    s = moveToGroup(s, "/a", null);
    expect(groupOf(s, "/a")).toBeUndefined();
  });

  it("rename ignores empty names; deleting a group keeps chats out of any group", () => {
    let s = createGroup(empty, "  ", "g1", "/a");
    expect(s.groups[0].name).toBe("Nowa grupa");
    s = renameGroup(s, "g1", "   ");
    expect(s.groups[0].name).toBe("Nowa grupa");
    s = renameGroup(s, "g1", "Blender");
    expect(s.groups[0].name).toBe("Blender");
    s = deleteGroup(s, "g1");
    expect(s.groups).toEqual([]);
  });

  it("projects: most recent first, added-but-empty last, no duplicates", () => {
    const s = addProject(addProject(empty, "/nowy"), "/nowy");
    expect(s.projects).toEqual(["/nowy"]);
    const list = projectEntries(
      [sess("/1", "/stary", "2026-09-01"), sess("/2", "/swiezy", "2026-09-20"), sess("/3", "/stary", "2026-09-10")],
      ["/nowy", "/stary"],
    );
    expect(list.map((p) => [p.cwd, p.sessions.length, p.added])).toEqual([
      ["/swiezy", 1, false],
      ["/stary", 2, true],
      ["/nowy", 0, true],
    ]);
    expect(list[1].latest).toBe("2026-09-10");
  });
});
