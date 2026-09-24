import { describe, expect, it } from "vitest";
import { DEFAULT_GOAL, handoffMessages, handoffUserText } from "./handoff";

const msg = (id: string, text: string) => ({ type: "message", id, message: { role: "user", content: text, timestamp: 0 } });

describe("handoff", () => {
  it("takes every message of an uncompacted branch and skips other entries", () => {
    const out = handoffMessages([msg("a", "jeden"), { type: "model_change", id: "m" }, msg("b", "dwa")]);
    expect(out).toEqual([msg("a", "jeden").message, msg("b", "dwa").message]);
  });

  it("after a compaction: its summary, the kept entries, then what came after", () => {
    const out = handoffMessages([
      msg("a", "stare"),
      msg("b", "zachowane"),
      { type: "compaction", id: "c", summary: "streszczenie", tokensBefore: 5000, firstKeptEntryId: "b", timestamp: "2026-09-24T10:00:00Z" },
      msg("d", "nowe"),
    ]);
    expect(out).toEqual([
      { role: "compactionSummary", summary: "streszczenie", tokensBefore: 5000, timestamp: Date.parse("2026-09-24T10:00:00Z") },
      msg("b", "zachowane").message,
      msg("d", "nowe").message,
    ]);
  });

  it("an empty goal means: continue where it left off", () => {
    expect(handoffUserText("rozmowa", "  ")).toContain(DEFAULT_GOAL);
    expect(handoffUserText("rozmowa", "dodaj testy")).toMatch(/rozmowa[\s\S]*dodaj testy$/);
  });
});
