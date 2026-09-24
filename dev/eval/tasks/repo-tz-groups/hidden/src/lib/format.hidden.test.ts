import { describe, expect, it } from "vitest";
import { groupSessions } from "./format";

const s = (id: string, modified: string) => ({ id, path: `/s/${id}`, cwd: "/p", name: "", firstMessage: id, modified, messageCount: 1 }) as never;

describe("groupSessions uses the local calendar day", () => {
  it("puts a session from 00:30 today under Dziś and 23:50 yesterday under Wczoraj", () => {
    const now = new Date(2026, 8, 24, 10, 0);
    const groups = groupSessions([s("a", new Date(2026, 8, 24, 0, 30).toISOString()), s("b", new Date(2026, 8, 23, 23, 50).toISOString()), s("c", new Date(2026, 8, 22, 1, 0).toISOString())], now);
    expect(groups.map((g) => [g.label, g.items.map((i: { id: string }) => i.id)])).toEqual([
      ["Dziś", ["a"]],
      ["Wczoraj", ["b"]],
      ["Ostatnie 7 dni", ["c"]],
    ]);
  });
});
