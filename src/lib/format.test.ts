import { describe, expect, it } from "vitest";
import { formatDuration, formatTokens, groupSessions, recentProjects, relativeTime, shortModelName } from "./format";
import type { SessionSummary } from "../../shared/protocol";

const sess = (modified: string): SessionSummary => ({
  path: modified,
  id: "x",
  cwd: "/w",
  modified,
  messageCount: 1,
  firstMessage: "hej",
});

describe("format", () => {
  it("formatDuration", () => {
    expect(formatDuration(870)).toBe("0,9 s");
    expect(formatDuration(12_400)).toBe("12 s");
    expect(formatDuration(72_000)).toBe("1 min 12 s");
  });

  it("formatTokens", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_345)).toBe("12,3 tys.");
    expect(formatTokens(262_144)).toBe("262 tys.");
  });

  it("relativeTime", () => {
    const now = new Date("2026-09-24T12:00:00Z").getTime();
    expect(relativeTime("2026-09-24T11:59:40Z", now)).toBe("teraz");
    expect(relativeTime("2026-09-24T11:15:00Z", now)).toBe("45 min");
    expect(relativeTime("2026-09-24T07:00:00Z", now)).toBe("5 godz.");
    expect(relativeTime("2026-09-21T12:00:00Z", now)).toBe("3 d");
  });

  it("groupSessions buckets by calendar day", () => {
    const now = new Date(2026, 8, 24, 12, 0);
    const groups = groupSessions(
      [
        sess(new Date(2026, 8, 24, 9, 0).toISOString()),
        sess(new Date(2026, 8, 23, 22, 0).toISOString()),
        sess(new Date(2026, 8, 20, 10, 0).toISOString()),
        sess(new Date(2026, 5, 1).toISOString()),
      ],
      now,
    );
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ["Dziś", 1],
      ["Wczoraj", 1],
      ["Ostatnie 7 dni", 1],
      ["Starsze", 1],
    ]);
  });
});

describe("recentProjects", () => {
  const s = (cwd: string, modified: string, id = modified): SessionSummary => ({ path: `/s/${id}.jsonl`, id, cwd, modified, messageCount: 2, firstMessage: id });
  it("newest projects first, each with its newest chat; /tmp and scratchpads left out", () => {
    const got = recentProjects([
      s("/home/u/a", "2026-09-20T10:00:00Z"),
      s("/home/u/b", "2026-09-26T10:00:00Z"),
      s("/home/u/a", "2026-09-27T09:00:00Z", "a-new"),
      s("/tmp", "2026-09-27T12:00:00Z"),
      s("/tmp/claude-1000/x/scratchpad", "2026-09-27T12:00:00Z"),
      s("/home/u/c", "2026-09-01T10:00:00Z"),
    ], 2);
    expect(got.map((p) => [p.cwd, p.last.id, p.sessions])).toEqual([
      ["/home/u/a", "a-new", 2],
      ["/home/u/b", "2026-09-26T10:00:00Z", 1],
    ]);
  });
});

describe("shortModelName", () => {
  it.each([
    ["Swift-Qwen3.8-27B-Q8_0-2GPU", "Swift Q8 · 2GPU"],
    ["Swift-Qwen3.8-27B-Q8_0-2GPU-safe", "Swift Q8 · 2GPU"],
    ["Swift1.5-Qwen3.8-27B-Q6_K-2GPU", "Swift1.5 Q6_K · 2GPU"],
    ["Swift-1.5-Qwen3.8-Flash-Next-GSQRCO-IQ2_XS-2GPU", "Swift 1.5 Flash IQ2_XS · 2GPU"],
    ["Qwen3.8-Flash-Next-256k-2GPU-GSQRCO", "Qwen3.8 Flash · 2GPU"],
    ["Qwen-3.8-27B-Uncensored.Q4_K_M", "Qwen 3.8 Q4_K_M"],
    ["Tiel-Coder-35B-A3B-MTP-UD-Q6_K_XL", "Tiel Coder Q6_K_XL"],
    ["unsloth/Qwen3.8-Flash-Next-GGUF:Q4_K_XL", "Qwen3.8 Flash Q4_K_XL"],
    ["claude-sonnet-5", "claude-sonnet-5"],
    ["Qwen3.8-Flash-Next-128k", "Qwen3.8-Flash-Next-128k"],
  ])("%s → %s", (id, short) => expect(shortModelName(id)).toBe(short));
});
