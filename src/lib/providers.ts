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

/** Models of one provider next to each other; providers keep the order of their first model. */
export function groupByProvider<M extends { provider: string }>(models: M[]): M[] {
  const order = new Map<string, number>();
  for (const m of models) if (!order.has(m.provider)) order.set(m.provider, order.size);
  return models
    .map((m, i) => ({ m, i }))
    .sort((a, b) => order.get(a.m.provider)! - order.get(b.m.provider)! || a.i - b.i)
    .map((x) => x.m);
}
