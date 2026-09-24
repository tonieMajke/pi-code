import type { Perf, SamplingConfig } from "../../shared/protocol.js";

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

let listener: ((p: Perf) => void) | null = null;
export function onPerf(fn: ((p: Perf) => void) | null): void {
  listener = fn;
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

async function consume(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  const meter = new GenMeter();
  let buf = "";
  let last: Timings | null = null;
  let lastEmit = 0;
  const emit = (p: Perf, force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < EMIT_EVERY_MS) return;
    lastEmit = now;
    listener?.(p);
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
      emit(
        {
          phase: "done",
          promptTokens,
          cacheTokens: last.cache_n ?? 0,
          promptPerSec: promptMs > 0 ? (promptTokens / promptMs) * 1000 : 0,
          promptMs,
          genTokens,
          genPerSec: genMs > 0 ? (genTokens / genMs) * 1000 : 0,
          genMs,
        },
        true,
      );
    }
  }
}

function isLocalChatCompletion(url: string): boolean {
  try {
    const u = new URL(url);
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) && u.pathname.endsWith("/chat/completions");
  } catch {
    return false;
  }
}

let installed = false;
let sampling: SamplingConfig | null = null;

/** Per-request sampling override (GUI setting); null fields keep the router preset's value. */
export function setSampling(cfg: SamplingConfig): void {
  sampling = cfg;
}

let slot: number | null = null;

/**
 * Run fn with every local chat request pinned to one llama.cpp slot (id_slot). The critic
 * uses slot 1 so it doesn't evict the main conversation's KV cache from slot 0 — only
 * useful when the server runs with --parallel ≥ 2.
 */
export async function withSlot<T>(id: number | null, fn: () => Promise<T>): Promise<T> {
  const prev = slot;
  slot = id;
  try {
    return await fn();
  } finally {
    slot = prev;
  }
}

const SAMPLING_KEYS = ["temperature", "top_p", "top_k", "min_p", "presence_penalty", "repeat_penalty", "reasoning_budget_tokens"] as const;

/** Said inside the thinking block when the budget runs out, so the answer that follows makes sense. */
const BUDGET_MESSAGE = "\n\nI have thought enough about this step. Time to act on what I have.\n";

export function applySampling(obj: Record<string, unknown>, cfg: SamplingConfig | null): void {
  if (!cfg?.enabled) return;
  for (const k of SAMPLING_KEYS) if (cfg[k] !== null) obj[k] = cfg[k];
  if (cfg.reasoning_budget_tokens !== null) obj.reasoning_budget_message = BUDGET_MESSAGE;
}

export function installFetchTap(): void {
  if (installed) return;
  installed = true;
  const orig = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!isLocalChatCompletion(url) || typeof init?.body !== "string") return orig(input, init);
    let body = init.body;
    try {
      const obj = JSON.parse(body) as Record<string, unknown>;
      if (obj.stream === true) {
        obj.timings_per_token = true;
        obj.return_progress = true;
        applySampling(obj, sampling);
        if (slot !== null) obj.id_slot = slot;
        body = JSON.stringify(obj);
      }
    } catch {
      return orig(input, init);
    }
    const res = await orig(input, { ...init, body });
    if (!res.ok || !res.body) return res;
    const [forPi, forUs] = res.body.tee();
    void consume(forUs);
    return new Response(forPi, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}
