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

  it("parseChunk marks chunks with generated output and reads usage", () => {
    expect(parseChunk('data: {"choices":[{"delta":{"role":"assistant","content":""}}]}')?.generated).toBe(false);
    expect(parseChunk('data: {"choices":[{"delta":{"reasoning_content":"We"}}]}')?.generated).toBe(true);
    expect(parseChunk('data: {"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}')?.generated).toBe(true);
    const u = parseChunk('data: {"choices":[],"usage":{"prompt_tokens":57,"completion_tokens":152,"prompt_tokens_details":{"cached_tokens":40}}}');
    expect(u?.usage?.completion_tokens).toBe(152);
    expect(u?.usage?.prompt_tokens_details?.cached_tokens).toBe(40);
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

describe("fetch tap on a local server without llama.cpp timings", () => {
  it("measures prompt time and decode speed itself and asks for usage", async () => {
    const { createServer } = await import("node:http");
    const { installFetchTap, onPerf } = await import("./perf");
    let sentBody: Record<string, unknown> = {};
    const server = createServer((req, res) => {
      if (req.url === "/health") return res.writeHead(200, { server: "uvicorn" }).end("{}");
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", async () => {
        sentBody = JSON.parse(raw);
        res.writeHead(200, { "content-type": "text/event-stream" });
        await new Promise((r) => setTimeout(r, 100)); // "prompt processing"
        res.write('data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n');
        for (let i = 0; i < 5; i++) {
          res.write(`data: {"choices":[{"delta":{"content":"t${i}"}}]}\n\n`);
          await new Promise((r) => setTimeout(r, 20));
        }
        res.write('data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":900}}}\n\n');
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const seen: import("../../shared/protocol").Perf[] = [];
    onPerf((p) => seen.push(p));
    installFetchTap();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "m", stream: true, messages: [] }),
      });
      expect(await res.text()).toContain("[DONE]");
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      onPerf(null);
      server.close();
    }
    expect(sentBody.stream_options).toEqual({ include_usage: true });
    expect(sentBody.timings_per_token).toBeUndefined();
    const done = seen.find((p) => p.phase === "done");
    expect(done).toMatchObject({ phase: "done", promptTokens: 1000, cacheTokens: 900, genTokens: 5 });
    if (done?.phase !== "done") throw new Error("no done");
    expect(done.promptMs).toBeGreaterThanOrEqual(90);
    expect(done.promptPerSec).toBeGreaterThan(0);
    expect(done.promptPerSec).toBeLessThan(1100); // 100 fresh tokens in ≥ 0.1 s
    expect(done.genPerSec).toBeGreaterThan(20);
    expect(seen.some((p) => p.phase === "gen")).toBe(true);
  });
});
