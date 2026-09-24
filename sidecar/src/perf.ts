import { AsyncLocalStorage } from "node:async_hooks";
import type { Perf, RequestRole, SamplingConfig } from "../../shared/protocol.js";

/**
 * Live llama.cpp speed readout without touching pi internals.
 *
 * pi talks to llama-server through global fetch. We wrap it: chat-completion
 * requests to a local server get `timings_per_token` + `return_progress`
 * (llama-server extensions), and a tee of the SSE stream is parsed for the
 * `timings` / `prompt_progress` fields pi itself ignores.
 */

type Timings = {
  cache_n?: number;
  prompt_n?: number;
  prompt_ms?: number;
  predicted_n?: number;
  predicted_ms?: number;
};
type Progress = { total: number; cache: number; processed: number; time_ms: number };

/**
 * Who a model request is for. Set around session.prompt() and side calls (critic, review,
 * handoff, memory); pi's fetch runs in the same async chain, so the tap sees it even with
 * several sessions or a critic running at once.
 */
export type RequestContext = {
  sessionId: string;
  cwd: string;
  role: RequestRole;
  /** llama.cpp slot to pin the request to (id_slot); null = the server picks. */
  slot?: number | null;
};

const context = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return context.run(ctx, fn);
}

export function requestContext(): RequestContext | undefined {
  return context.getStore();
}

/** One finished llama.cpp request, as the stats log stores it. */
export type RequestRecord = Extract<Perf, { phase: "done" }> & {
  model: string;
  /** From sending the request to the first generated token. */
  ttftMs: number | null;
  ctx: RequestContext | undefined;
};

let listener: ((p: Perf, ctx: RequestContext | undefined) => void) | null = null;
export function onPerf(fn: ((p: Perf, ctx: RequestContext | undefined) => void) | null): void {
  listener = fn;
}

let recorder: ((r: RequestRecord) => void) | null = null;
/** Every finished request (all sessions and roles) — the persistent stats log. */
export function onRequestDone(fn: ((r: RequestRecord) => void) | null): void {
  recorder = fn;
}

const EMIT_EVERY_MS = 200;
const WINDOW_MS = 1000;

/** Rolling "current" decode speed from server-side (n, ms) samples. */
export class GenMeter {
  private samples: { n: number; ms: number }[] = [];
  add(n: number, ms: number): number {
    this.samples.push({ n, ms });
    while (this.samples.length > 2 && ms - this.samples[0].ms > WINDOW_MS) this.samples.shift();
    const first = this.samples[0];
    const dn = n - first.n;
    const dms = ms - first.ms;
    return dms > 0 ? (dn / dms) * 1000 : 0;
  }
}

export function parseChunk(line: string): { timings?: Timings; progress?: Progress } | null {
  if (!line.startsWith("data:")) return null;
  const json = line.slice(5).trim();
  if (!json || json === "[DONE]") return null;
  try {
    const obj = JSON.parse(json) as { timings?: Timings; prompt_progress?: Progress };
    return { timings: obj.timings, progress: obj.prompt_progress };
  } catch {
    return null;
  }
}

async function consume(stream: ReadableStream<Uint8Array>, req: { ctx: RequestContext | undefined; model: string; sentAt: number }): Promise<void> {
  const reader = stream.getReader();
  let ttftMs: number | null = null;
  const dec = new TextDecoder();
  const meter = new GenMeter();
  let buf = "";
  let last: Timings | null = null;
  let lastEmit = 0;
  const emit = (p: Perf, force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < EMIT_EVERY_MS) return;
    lastEmit = now;
    listener?.(p, req.ctx);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const chunk = parseChunk(buf.slice(0, idx).trim());
        buf = buf.slice(idx + 1);
        if (!chunk) continue;
        const { progress, timings } = chunk;
        if (progress && progress.total > 0) {
          const fresh = progress.processed - progress.cache;
          emit({
            phase: "prompt",
            processed: progress.processed,
            total: progress.total,
            cache: progress.cache,
            perSec: progress.time_ms > 0 ? (fresh / progress.time_ms) * 1000 : 0,
          });
        }
        if (timings) {
          last = timings;
          const n = timings.predicted_n ?? 0;
          const ms = timings.predicted_ms ?? 0;
          if (n > 0) {
            ttftMs ??= Date.now() - req.sentAt;
            const perSec = meter.add(n, ms);
            emit({ phase: "gen", tokens: n, perSec, avgPerSec: ms > 0 ? (n / ms) * 1000 : 0 });
          }
        }
      }
    }
  } catch {
    // aborted request — nothing to report
  } finally {
    if (last) {
      const promptTokens = last.prompt_n ?? 0;
      const promptMs = last.prompt_ms ?? 0;
      const genTokens = last.predicted_n ?? 0;
      const genMs = last.predicted_ms ?? 0;
      const done: Extract<Perf, { phase: "done" }> = {
        phase: "done",
        promptTokens,
        cacheTokens: last.cache_n ?? 0,
        promptPerSec: promptMs > 0 ? (promptTokens / promptMs) * 1000 : 0,
        promptMs,
        genTokens,
        genPerSec: genMs > 0 ? (genTokens / genMs) * 1000 : 0,
        genMs,
      };
      emit(done, true);
      try {
        recorder?.({ ...done, model: req.model, ttftMs, ctx: req.ctx });
      } catch {
        /* a broken stats log must not break the session */
      }
    }
  }
}

/** Hosts worth asking whether they are llama.cpp: this machine and private networks. */
function isPrivateHost(host: string): boolean {
  return (
    /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(host) ||
    host.endsWith(".local")
  );
}

export function chatCompletionOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return isPrivateHost(u.hostname) && u.pathname.endsWith("/chat/completions") ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * llama-server answers with "Server: llama.cpp". Only it gets the extra request
 * fields (timings, progress, reasoning budget, slots) — vLLM, Ollama or LM Studio
 * on localhost may warn about or reject them. One probe per origin, cached.
 */
const llamaOrigins = new Map<string, Promise<boolean>>();
export function isLlamaServer(origin: string, fetchFn: typeof fetch): Promise<boolean> {
  let known = llamaOrigins.get(origin);
  if (!known) {
    known = fetchFn(`${origin}/health`, { signal: AbortSignal.timeout(3000) })
      .then((r) => (r.headers.get("server") ?? "").toLowerCase().includes("llama.cpp"))
      .catch(() => false);
    llamaOrigins.set(origin, known);
    // A failed probe (server still starting) is retried on a later request.
    void known.then((ok) => {
      if (!ok) setTimeout(() => llamaOrigins.delete(origin), 30_000);
    });
  }
  return known;
}

let installed = false;
let sampling: SamplingConfig | null = null;

/** Per-request sampling override (GUI setting); null fields keep the router preset's value. */
export function setSampling(cfg: SamplingConfig): void {
  sampling = cfg;
}

/**
 * Run fn with every local chat request pinned to one llama.cpp slot (id_slot). The critic
 * uses slot 1 so it doesn't evict the main conversation's KV cache from slot 0 — only
 * useful when the server runs with --parallel ≥ 2. Scoped to fn's async chain (not a
 * global), so a session running meanwhile keeps its own slot.
 */
export function withSlot<T>(id: number | null, fn: () => Promise<T>): Promise<T> {
  const cur = context.getStore();
  return context.run({ sessionId: "", cwd: "", role: "main", ...cur, slot: id }, fn);
}

const SAMPLING_KEYS = ["temperature", "top_p", "top_k", "min_p", "presence_penalty", "repeat_penalty"] as const;

/** Said inside the thinking block when the budget runs out, so the answer that follows makes sense. */
const BUDGET_MESSAGE = "\n\nI have thought enough about this step. Time to act on what I have.\n";

export function applySampling(obj: Record<string, unknown>, cfg: SamplingConfig | null): void {
  if (!cfg) return;
  // The thinking budget stands on its own (on by default); the rest only with the override switch.
  if (cfg.reasoning_budget_tokens) {
    obj.reasoning_budget_tokens = cfg.reasoning_budget_tokens;
    obj.reasoning_budget_message = BUDGET_MESSAGE;
  }
  if (!cfg.enabled) return;
  for (const k of SAMPLING_KEYS) if (cfg[k] !== null) obj[k] = cfg[k];
}

export function installFetchTap(): void {
  if (installed) return;
  installed = true;
  const orig = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const origin = chatCompletionOrigin(url);
    if (!origin || typeof init?.body !== "string" || !(await isLlamaServer(origin, orig))) return orig(input, init);
    let body = init.body;
    const ctx = context.getStore();
    let model = "";
    try {
      const obj = JSON.parse(body) as Record<string, unknown>;
      model = typeof obj.model === "string" ? obj.model : "";
      if (obj.stream === true) {
        obj.timings_per_token = true;
        obj.return_progress = true;
        applySampling(obj, sampling);
        if (ctx?.slot !== undefined && ctx.slot !== null) obj.id_slot = ctx.slot;
        body = JSON.stringify(obj);
      }
    } catch {
      return orig(input, init);
    }
    const sentAt = Date.now();
    const res = await orig(input, { ...init, body });
    if (!res.ok || !res.body) return res;
    const [forPi, forUs] = res.body.tee();
    void consume(forUs, { ctx, model, sentAt });
    return new Response(forPi, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}
