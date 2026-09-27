import type { Part, RequestStats } from "./reducer";

export type SpanKind = "prompt" | "gen" | "tool" | "wait";
export interface Span {
  kind: SpanKind;
  start: number;
  end: number;
  /** Tooltip: which request / tool. */
  label: string;
}

export interface Timeline {
  start: number;
  end: number;
  /** Model lane (prompt processing, generation) and tools lane (running, waiting for approval). */
  model: Span[];
  tools: Span[];
  /** Totals per kind in ms — also known for reloaded sessions, which have no tool times. */
  totals: Record<SpanKind, number>;
}

/**
 * Where a turn's time went. Model requests come from the llama.cpp/stream stats (sent → last
 * token; prompt = until the first token), tools from their start/end, approval waits from the
 * permission prompt. Spans without timestamps still count in the totals.
 */
export function turnTimeline(parts: Part[], stats: RequestStats[] = []): Timeline | null {
  const totals: Record<SpanKind, number> = { prompt: 0, gen: 0, tool: 0, wait: 0 };
  const model: Span[] = [];
  const tools: Span[] = [];
  stats.forEach((s, i) => {
    totals.prompt += s.promptMs;
    totals.gen += s.genMs;
    if (s.at === undefined) return;
    const genStart = s.at - s.genMs;
    const sent = s.sentAt ?? genStart - s.promptMs;
    const label = `#${i + 1}`;
    if (genStart > sent) model.push({ kind: "prompt", start: sent, end: genStart, label });
    if (s.at > genStart) model.push({ kind: "gen", start: genStart, end: s.at, label });
  });
  for (const p of parts) {
    if (p.type !== "tool") continue;
    const t = p.tool;
    const [asked, answered] = t.wait ?? [];
    const waited = asked !== undefined && answered !== undefined ? answered - asked : 0;
    if (asked !== undefined && answered !== undefined) {
      totals.wait += waited;
      tools.push({ kind: "wait", start: asked, end: answered, label: t.name });
    }
    if (t.start === undefined || t.end === undefined) continue;
    totals.tool += Math.max(0, t.end - t.start - waited);
    // The tool runs after its approval; the part before it is the wait drawn above.
    const runStart = answered !== undefined && answered > t.start ? answered : t.start;
    if (t.end > runStart) tools.push({ kind: "tool", start: runStart, end: t.end, label: t.name });
  }
  const all = [...model, ...tools];
  if (!all.length && totals.prompt + totals.gen === 0) return null;
  return {
    start: all.length ? Math.min(...all.map((s) => s.start)) : 0,
    end: all.length ? Math.max(...all.map((s) => s.end)) : 0,
    model,
    tools,
    totals,
  };
}
