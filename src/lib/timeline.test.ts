import { describe, expect, it } from "vitest";
import type { Part, RequestStats } from "./reducer";
import { turnTimeline } from "./timeline";

const req = (sentAt: number, promptMs: number, genMs: number): RequestStats => ({
  phase: "done", promptTokens: 1000, cacheTokens: 0, promptPerSec: 0, promptMs, genTokens: 100, genPerSec: 0, genMs, sentAt, at: sentAt + promptMs + genMs,
});

describe("turnTimeline", () => {
  it("lays out requests, tools and the wait for approval, with totals", () => {
    const parts: Part[] = [
      { type: "tool", tool: { id: "a", name: "bash", args: {}, status: "ok", summary: "", start: 3000, end: 9000, wait: [3000, 5000] } },
    ];
    const tl = turnTimeline(parts, [req(1000, 1000, 1000), req(9000, 500, 2500)])!;
    expect(tl.model.map((s) => [s.kind, s.start, s.end])).toEqual([
      ["prompt", 1000, 2000], ["gen", 2000, 3000], ["prompt", 9000, 9500], ["gen", 9500, 12000],
    ]);
    expect(tl.tools.map((s) => [s.kind, s.start, s.end])).toEqual([["wait", 3000, 5000], ["tool", 5000, 9000]]);
    expect(tl.totals).toEqual({ prompt: 1500, gen: 3500, tool: 4000, wait: 2000 });
    expect([tl.start, tl.end]).toEqual([1000, 12000]);
  });

  it("a reloaded turn (no timestamps) still has totals, no lanes", () => {
    const { at: _a, sentAt: _s, ...old } = req(0, 800, 1200);
    const tl = turnTimeline([], [old])!;
    expect(tl.model).toEqual([]);
    expect(tl.totals.prompt).toBe(800);
    expect(tl.end).toBe(tl.start);
  });
});
