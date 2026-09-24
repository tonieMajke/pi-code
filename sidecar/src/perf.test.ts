import { describe, expect, it } from "vitest";
import { GenMeter, parseChunk } from "./perf";

describe("perf", () => {
  it("parseChunk reads timings and prompt_progress from SSE data lines", () => {
    const line =
      'data: {"choices":[],"timings":{"prompt_n":16,"prompt_ms":113,"predicted_n":0,"predicted_ms":0},"prompt_progress":{"total":16,"cache":0,"processed":16,"time_ms":113}}';
    const c = parseChunk(line);
    expect(c?.timings?.prompt_n).toBe(16);
    expect(c?.progress?.processed).toBe(16);
    expect(parseChunk("data: [DONE]")).toBeNull();
    expect(parseChunk(": keepalive")).toBeNull();
    expect(parseChunk("data: {broken")).toBeNull();
  });

  it("GenMeter reports the rate over the last second, not the request average", () => {
    const m = new GenMeter();
    m.add(0, 0);
    m.add(100, 1000); // 100 t/s for the first second
    m.add(110, 1500);
    const now = m.add(120, 2000); // then 20 t/s
    expect(Math.round(now)).toBe(20);
  });
});

describe("request context", () => {
  it("each concurrent chain keeps its own context and slot (no global)", async () => {
    const { requestContext, withRequestContext, withSlot } = await import("./perf");
    const seen: string[] = [];
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const run = (id: string, slot: number | null) =>
      withRequestContext({ sessionId: id, cwd: "/w", role: "main" }, async () => {
        await tick();
        await withSlot(slot, async () => {
          await tick();
          const c = requestContext();
          seen.push(`${c?.sessionId}:${c?.role}:${c?.slot}`);
        });
        seen.push(`${requestContext()?.sessionId}:after:${requestContext()?.slot}`);
      });
    await Promise.all([run("a", 1), run("b", null)]);
    expect(seen.sort()).toEqual(["a:after:undefined", "a:main:1", "b:after:undefined", "b:main:null"]);
    expect(requestContext()).toBeUndefined();
  });
});
