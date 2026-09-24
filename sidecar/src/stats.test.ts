import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aggregate, appendStats, percentile, readStats } from "./stats";
import type { StatsRecord } from "../../shared/protocol";

const day = (d: string, h = 12) => new Date(`${d}T${String(h).padStart(2, "0")}:00:00`).getTime();
const rec = (over: Partial<StatsRecord>): StatsRecord => ({
  ts: day("2026-09-24"),
  sessionId: "s1",
  cwd: "/p/a",
  role: "main",
  model: "swift",
  promptTokens: 1000,
  cacheTokens: 3000,
  promptMs: 500,
  genTokens: 100,
  genMs: 1000,
  ttftMs: 600,
  ...over,
});

let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("stats log", () => {
  it("appends lines and skips a torn one", () => {
    dir = mkdtempSync(join(tmpdir(), "pi-gui-stats-"));
    const file = join(dir, "sub", "stats.jsonl");
    appendStats(file, rec({}));
    appendStats(file, rec({ model: "other" }));
    writeFileSync(file, `${readStats(file).map((r) => JSON.stringify(r)).join("\n")}\n{"ts":1,"mod`);
    expect(readStats(file).map((r) => r.model)).toEqual(["swift", "other"]);
    expect(readStats(join(dir, "missing.jsonl"))).toEqual([]);
  });

  it("percentile is nearest-rank", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 10)).toBe(10);
  });
});

describe("aggregate", () => {
  const now = day("2026-09-24", 20);
  const records = [
    rec({}), // PP 2000 t/s, gen 100 t/s
    rec({ promptTokens: 2000, promptMs: 2000, genTokens: 200, genMs: 4000, ttftMs: 2000 }), // PP 1000, gen 50
    rec({ promptTokens: 100, promptMs: 1000, genTokens: 5, genMs: 1000 }), // too small for speed stats
    rec({ role: "critic", model: "swift", cwd: "/p/a", ts: day("2026-09-23") }),
    rec({ model: "qwen", cwd: "/p/b", ts: day("2026-09-20"), cacheTokens: 0 }),
    rec({ model: "old", ts: day("2026-08-01") }),
  ];

  it("per model: requests, tokens, cache %, median and p10 speeds, TTFT", () => {
    const s = aggregate(records, 7, "/f", now);
    expect(s.total.requests).toBe(5); // August is out of range
    const swift = s.models.find((m) => m.model === "swift")!;
    expect(swift.requests).toBe(4);
    expect(swift.promptTokens).toBe(1000 + 2000 + 100 + 1000);
    expect(swift.cacheHitPct).toBeCloseTo((12000 / (4100 + 12000)) * 100);
    // PP over the 3 requests with ≥ 512 tokens: 2000, 1000, 2000
    expect(swift.ppMedian).toBe(2000);
    expect(swift.ppP10).toBe(1000);
    expect(swift.genMedian).toBe(100);
    expect(swift.genP10).toBe(50);
    expect(swift.ttftMedianMs).toBe(600);
    expect(s.models[0].model).toBe("swift"); // most requests first
    expect(s.models.find((m) => m.model === "qwen")!.cacheHitPct).toBe(0);
  });

  it("days are continuous; projects and helper overhead counted apart", () => {
    const s = aggregate(records, 7, "/f", now);
    expect(s.days.map((d) => d.day)).toEqual(["2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"]);
    expect(s.days[6].requests).toBe(3);
    expect(s.days[1].requests).toBe(0);
    expect(s.projects.map((p) => [p.cwd, p.requests])).toEqual([
      ["/p/a", 4],
      ["/p/b", 1],
    ]);
    expect(s.overhead).toEqual([{ role: "critic", requests: 1, promptTokens: 1000, genTokens: 100 }]);
  });

  it("all = from the first record", () => {
    const s = aggregate(records, "all", "/f", now);
    expect(s.total.requests).toBe(6);
    expect(s.days[0].day).toBe("2026-08-01");
    expect(s.days[s.days.length - 1].day).toBe("2026-09-24");
  });
});
