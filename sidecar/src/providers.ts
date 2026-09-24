import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CustomEndpoint, EndpointProbe, ProviderInfo } from "../../shared/protocol.js";
import { t } from "../../shared/i18n.js";

/**
 * Providers without the terminal: pi keeps API keys in auth.json (written through
 * ModelRuntime.login, same as /login) and extra OpenAI-compatible servers in
 * models.json. OAuth sign-ins (subscriptions, Copilot) stay in `pi` → /login.
 */

type ModelsJson = { providers?: Record<string, Record<string, unknown>>; [k: string]: unknown };

function readModelsJson(file: string): ModelsJson {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ModelsJson;
  } catch {
    return {};
  }
}

function writeModelsJson(file: string, data: ModelsJson): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

const SOURCE_LABEL: Record<string, string> = {
  stored: "auth.json",
  runtime: "runtime",
  models_json_key: "models.json",
  models_json_command: "models.json",
};

export async function listProviders(rt: ModelRuntime, modelsFile: string): Promise<ProviderInfo[]> {
  const custom = new Set(Object.keys(readModelsJson(modelsFile).providers ?? {}));
  const available = await rt.getAvailable().catch(() => rt.getAvailableSnapshot());
  const counts = new Map<string, number>();
  for (const m of available) counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
  const list = rt.getProviders().map((p): ProviderInfo => {
    const status = rt.getProviderAuthStatus(p.id);
    const models = counts.get(p.id) ?? 0;
    return {
      id: p.id,
      name: p.name || p.id,
      configured: status.configured || models > 0,
      source: status.label ?? (status.source ? (SOURCE_LABEL[status.source] ?? status.source) : ""),
      models,
      apiKey: Boolean(p.auth.apiKey?.login),
      oauthOnly: Boolean(p.auth.oauth) && !p.auth.apiKey?.login,
      stored: status.source === "stored",
      custom: custom.has(p.id),
    };
  });
  // Configured first, then by name — the full catalog is long.
  return list.sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
}

/** pi's own api-key login flow with the key already in hand; anything more (account ids…) → terminal. */
export async function setProviderKey(rt: ModelRuntime, provider: string, key: string): Promise<void> {
  const p = rt.getProvider(provider);
  if (!p) throw new Error(t("nieznany dostawca: {id}", { id: provider }));
  if (!p.auth.apiKey?.login) throw new Error(t("{name} wymaga logowania w przeglądarce — w terminalu: pi, potem /login", { name: p.name }));
  let asked = false;
  await rt.login(provider, "api_key", {
    prompt: async (q) => {
      if ((q.type === "secret" || q.type === "text") && !asked) {
        asked = true;
        return key.trim();
      }
      throw new Error(t("{name} pyta o więcej niż klucz API — skonfiguruj w terminalu: pi, potem /login", { name: p.name }));
    },
    notify: () => undefined,
  });
}

export async function logoutProvider(rt: ModelRuntime, provider: string): Promise<void> {
  await rt.logout(provider);
}

/** "localhost:8000" → "http://localhost:8000/v1"; an explicit path is kept. */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  const u = new URL(url);
  if (u.pathname === "" || u.pathname === "/") url = `${url}/v1`;
  return url.replace(/\/chat\/completions$/, "").replace(/\/models$/, "");
}

export async function probeEndpoint(baseUrl: string, apiKey?: string, fetchFn: typeof fetch = fetch): Promise<EndpointProbe> {
  const base = normalizeBaseUrl(baseUrl);
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  let res: Response;
  try {
    res = await fetchFn(`${base}/models`, { headers, signal: AbortSignal.timeout(8000) });
  } catch (err) {
    throw new Error(t("serwer nie odpowiada ({url}): {err}", { url: `${base}/models`, err: err instanceof Error ? err.message : String(err) }));
  }
  if (res.status === 401 || res.status === 403) throw new Error(t("serwer odrzucił klucz API ({status})", { status: res.status }));
  if (!res.ok) throw new Error(t("serwer zwrócił {status} dla {url}", { status: res.status, url: `${base}/models` }));
  const body = (await res.json().catch(() => ({}))) as {
    data?: { id?: string; max_model_len?: number; meta?: { n_ctx?: number } }[];
    models?: { name?: string; model?: string }[];
  };
  const ids: string[] = [];
  const contextWindows: Record<string, number> = {};
  for (const m of body.data ?? []) {
    if (!m.id) continue;
    ids.push(m.id);
    const ctx = m.max_model_len ?? m.meta?.n_ctx;
    if (typeof ctx === "number" && ctx > 0) contextWindows[m.id] = ctx;
  }
  // Ollama's native /api/tags shape, in case someone points at it.
  for (const m of body.models ?? []) if (m.model || m.name) ids.push((m.model ?? m.name)!);
  const llama = (res.headers.get("server") ?? "").toLowerCase().includes("llama.cpp");
  return { baseUrl: base, models: [...new Set(ids)], contextWindows, llama };
}

/** Provider id pi accepts: lowercase, dashes. */
export function endpointId(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-") || "custom"
  );
}

export function addEndpoint(modelsFile: string, ep: CustomEndpoint): string {
  const id = endpointId(ep.name);
  if (!ep.models.length) throw new Error(t("wybierz co najmniej jeden model"));
  const data = readModelsJson(modelsFile);
  const providers = { ...(data.providers ?? {}) };
  providers[id] = {
    ...providers[id],
    name: ep.name.trim() || id,
    baseUrl: normalizeBaseUrl(ep.baseUrl),
    api: "openai-completions",
    // pi only offers models whose provider has a key; local servers ignore this dummy.
    apiKey: ep.apiKey?.trim() || "none",
    models: ep.models.map((m) => (ep.contextWindows?.[m] ? { id: m, contextWindow: ep.contextWindows[m] } : { id: m })),
  };
  writeModelsJson(modelsFile, { ...data, providers });
  return id;
}

export function removeEndpoint(modelsFile: string, id: string): void {
  const data = readModelsJson(modelsFile);
  if (!data.providers?.[id]) return;
  const providers = { ...data.providers };
  delete providers[id];
  writeModelsJson(modelsFile, { ...data, providers });
}
