import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelStats, RequestRole, StatsRange, StatsRecord, StatsSummary } from "../../shared/protocol.js";

/**
 * Persistent per-request log of llama.cpp timings (~200 B a line, append-only, no rotation:
 * 100k requests ≈ 20 MB) and its aggregation for the "Statystyki" page.
 */

/** Below this many fresh prompt tokens, PP speed is server overhead, not throughput. */
export const PP_MIN_TOKENS = 512;
/** Same for generation: a 3-token answer has no meaningful t/s. */
export const GEN_MIN_TOKENS = 32;

export function appendStats(file: string, rec: StatsRecord): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(rec)}\n`);
}

export function readStats(file: string): StatsRecord[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: StatsRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as StatsRecord;
      if (typeof r.ts === "number" && typeof r.model === "string") out.push(r);
    } catch {
      /* a line cut by a crash — skip it */
    }
  }
  return out;
}

/** Nearest-rank percentile of an unsorted list (p in 0..100); null for an empty one. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Local midnight `days - 1` days before now: "7 days" = today and the six before it. */
function rangeStart(range: StatsRange, now: number): number | null {
  if (range === "all") return null;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (range - 1));
  return d.getTime();
}

export function aggregate(records: StatsRecord[], range: StatsRange, file: string, now = Date.now()): StatsSummary {
  const from = rangeStart(range, now);
  const rs = from === null ? records : records.filter((r) => r.ts >= from);

  const byModel = new Map<string, StatsRecord[]>();
  const byProject = new Map<string, StatsSummary["projects"][number]>();
  const byDay = new Map<string, StatsSummary["days"][number]>();
  const byRole = new Map<RequestRole, StatsSummary["overhead"][number]>();
  const total = { requests: 0, promptTokens: 0, genTokens: 0 };

  for (const r of rs) {
    total.requests++;
    total.promptTokens += r.promptTokens;
    total.genTokens += r.genTokens;
    byModel.set(r.model, [...(byModel.get(r.model) ?? []), r]);
    const p = byProject.get(r.cwd) ?? { cwd: r.cwd, requests: 0, promptTokens: 0, genTokens: 0 };
    p.requests++;
    p.promptTokens += r.promptTokens;
    p.genTokens += r.genTokens;
    byProject.set(r.cwd, p);
    const day = localDay(r.ts);
    const d = byDay.get(day) ?? { day, requests: 0, promptTokens: 0, genTokens: 0 };
    d.requests++;
    d.promptTokens += r.promptTokens;
    d.genTokens += r.genTokens;
    byDay.set(day, d);
    if (r.role !== "main") {
      const o = byRole.get(r.role) ?? { role: r.role, requests: 0, promptTokens: 0, genTokens: 0 };
      o.requests++;
      o.promptTokens += r.promptTokens;
      o.genTokens += r.genTokens;
      byRole.set(r.role, o);
    }
  }

  const models: ModelStats[] = [...byModel.entries()].map(([model, list]) => {
    const sum = (f: (r: StatsRecord) => number) => list.reduce((a, r) => a + f(r), 0);
    const promptTokens = sum((r) => r.promptTokens);
    const cacheTokens = sum((r) => r.cacheTokens);
    const pp = list.filter((r) => r.promptTokens >= PP_MIN_TOKENS && r.promptMs > 0).map((r) => (r.promptTokens / r.promptMs) * 1000);
    const gen = list.filter((r) => r.genTokens >= GEN_MIN_TOKENS && r.genMs > 0).map((r) => (r.genTokens / r.genMs) * 1000);
    const ttft = list.map((r) => r.ttftMs).filter((v): v is number => typeof v === "number");
    return {
      model,
      requests: list.length,
      promptTokens,
      cacheTokens,
      genTokens: sum((r) => r.genTokens),
      cacheHitPct: promptTokens + cacheTokens > 0 ? (cacheTokens / (promptTokens + cacheTokens)) * 100 : 0,
      ppMedian: percentile(pp, 50),
      ppP10: percentile(pp, 10),
      genMedian: percentile(gen, 50),
      genP10: percentile(gen, 10),
      ttftMedianMs: percentile(ttft, 50),
    };
  });
  models.sort((a, b) => b.requests - a.requests);

  // A continuous axis for the chart: empty days count too.
  const days: StatsSummary["days"] = [];
  const first = from ?? (rs.length ? Math.min(...rs.map((r) => r.ts)) : now);
  const cursor = new Date(first);
  cursor.setHours(12, 0, 0, 0); // noon: DST shifts never skip or repeat a day
  for (let guard = 0; guard < 3660 && cursor.getTime() <= now + 86_400_000; guard++) {
    const day = localDay(cursor.getTime());
    if (day > localDay(now)) break;
    days.push(byDay.get(day) ?? { day, requests: 0, promptTokens: 0, genTokens: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  return {
    range,
    file,
    total,
    models,
    days,
    projects: [...byProject.values()].sort((a, b) => b.requests - a.requests),
    overhead: [...byRole.values()].sort((a, b) => b.promptTokens + b.genTokens - (a.promptTokens + a.genTokens)),
  };
}
