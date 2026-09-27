/** Provider ids as pi knows them → the names people know them by (unknown ids stay as they are). */
const NAMES: Record<string, string> = {
  "llama-server": "llama.cpp",
  freetoken: "FreeToken",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  groq: "Groq",
  xai: "xAI",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  vllm: "vLLM",
};

export function providerLabel(id: string): string {
  return NAMES[id] ?? id;
}

/** Known local servers, for a sidecar too old to send `local`. */
const LOCAL = new Set(["llama-server", "freetoken", "ollama", "lmstudio", "vllm"]);

/**
 * Models of one provider next to each other. Local providers come first (hundreds of
 * OpenRouter models would bury them); otherwise providers keep the order of their first model.
 */
export function groupByProvider<M extends { provider: string; local?: boolean }>(models: M[]): M[] {
  const local = new Set(models.filter((m) => m.local || LOCAL.has(m.provider)).map((m) => m.provider));
  const order = new Map<string, number>();
  for (const m of models) if (!order.has(m.provider)) order.set(m.provider, order.size + (local.has(m.provider) ? 0 : 1e6));
  return models
    .map((m, i) => ({ m, i }))
    .sort((a, b) => order.get(a.m.provider)! - order.get(b.m.provider)! || a.i - b.i)
    .map((x) => x.m);
}
