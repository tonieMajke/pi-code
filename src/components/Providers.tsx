import { useEffect, useMemo, useState } from "react";
import { Check, KeyRound, Loader2, Server, Terminal, Trash2 } from "lucide-react";
import type { EndpointProbe, ProviderInfo } from "../../shared/protocol";
import { plural, t } from "../../shared/i18n";
import type { PiRequest } from "../lib/transport";

/** Popular ones first in the key picker; the rest follow alphabetically. */
const POPULAR = ["openrouter", "anthropic", "openai", "google", "deepseek", "mistral", "groq", "xai"];

const PRESETS: { label: string; name: string; url: string }[] = [
  { label: "vLLM", name: "vLLM", url: "http://localhost:8000/v1" },
  { label: "LM Studio", name: "LM Studio", url: "http://localhost:1234/v1" },
  { label: "Ollama", name: "Ollama", url: "http://localhost:11434/v1" },
  { label: "llama.cpp", name: "llama.cpp local", url: "http://localhost:8080/v1" },
  { label: "SGLang", name: "SGLang", url: "http://localhost:30000/v1" },
];

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Model providers without the terminal: what is configured, an API key for a
 * built-in provider (pi's auth.json), or any OpenAI-compatible server (models.json).
 * `compact` = the welcome screen's version (no list of every configured provider).
 */
export function ProvidersPanel({
  request,
  onChanged,
  compact,
  localLlama,
}: {
  request: PiRequest;
  onChanged: () => void;
  compact?: boolean;
  /** llama-server answers on :8080 — offered right away when nothing is configured yet. */
  localLlama?: boolean;
}) {
  const [list, setList] = useState<ProviderInfo[] | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"key" | "server">("key");

  const apply = (l: ProviderInfo[]) => {
    setList(l);
    onChanged();
  };
  const [suggest, setSuggest] = useState(false);
  useEffect(() => {
    request<ProviderInfo[]>({ cmd: "providers_list" }).then((l) => {
      setList(l);
      if (localLlama && !l.some((p) => p.configured)) {
        setTab("server");
        setSuggest(true);
      }
    }, (e) => setError(err(e)));
  }, [request, localLlama]);

  const configured = (list ?? []).filter((p) => p.configured);
  return (
    <div className="providers">
      {!compact && (
        <>
          <h3>{t("Skonfigurowani")}</h3>
          <ul className="prov-list">
            {!list && !error && <li className="mem-empty">{t("wczytywanie…")}</li>}
            {list && !configured.length && <li className="mem-empty">{t("Żaden dostawca nie jest skonfigurowany — dodaj klucz API albo serwer poniżej.")}</li>}
            {configured.map((p) => (
              <ProviderRow key={p.id} p={p} request={request} onList={apply} onError={setError} />
            ))}
          </ul>
        </>
      )}
      {compact && configured.length > 0 && (
        <p className="settings-note ok">
          <Check size={13} /> {t("Gotowe do użycia:")} {configured.map((p) => `${p.name} (${p.models})`).join(", ")}
        </p>
      )}
      {error && <p className="settings-note err">{error}</p>}

      <div className="segmented prov-tabs">
        <button className={tab === "key" ? "on" : ""} onClick={() => setTab("key")}>
          <KeyRound size={13} /> {t("Klucz API")}
        </button>
        <button className={tab === "server" ? "on" : ""} onClick={() => setTab("server")}>
          <Server size={13} /> {t("Własny serwer")}
        </button>
      </div>
      {tab === "key" ? (
        <KeyForm list={list ?? []} request={request} onList={apply} />
      ) : (
        <ServerForm request={request} onList={apply} preset={suggest ? PRESETS.find((p) => p.label === "llama.cpp") : undefined} />
      )}
      <p className="settings-note dim prov-oauth">
        <Terminal size={12} /> {t("Logowanie kontem (Claude Pro/Max, ChatGPT, GitHub Copilot) wymaga przeglądarki: w terminalu uruchom pi i wpisz /login. Pi Code zobaczy to po ponownym otwarciu listy.")}
      </p>
    </div>
  );
}

function ProviderRow({ p, request, onList, onError }: { p: ProviderInfo; request: PiRequest; onList: (l: ProviderInfo[]) => void; onError: (e: string) => void }) {
  const [armed, setArmed] = useState(false);
  const removable = p.stored || p.custom;
  const remove = () => {
    if (!armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 3000);
      return;
    }
    const cmd = p.custom ? ({ cmd: "endpoint_remove", name: p.id } as const) : ({ cmd: "provider_logout", provider: p.id } as const);
    request<ProviderInfo[]>(cmd).then(onList, (e) => onError(err(e)));
  };
  return (
    <li className="prov-item">
      <span className="prov-name">{p.name}</span>
      <span className="prov-meta">
        {plural(p.models, ["{n} model", "{n} modele", "{n} modeli"], ["{n} model", "{n} models"])}
        {p.source && ` · ${p.source === "fallback" ? t("bez klucza") : p.source}`}
      </span>
      <span className="bar-spacer" />
      {removable && (
        <button className={`btn ${armed ? "danger" : ""}`} onClick={remove} title={p.custom ? "models.json" : "auth.json"}>
          <Trash2 size={13} /> {armed ? t("Na pewno?") : p.custom ? t("Usuń") : t("Usuń klucz")}
        </button>
      )}
    </li>
  );
}

function KeyForm({ list, request, onList }: { list: ProviderInfo[]; request: PiRequest; onList: (l: ProviderInfo[]) => void }) {
  const options = useMemo(() => {
    const keyable = list.filter((p) => p.apiKey && !p.custom);
    const rank = (id: string) => (POPULAR.includes(id) ? POPULAR.indexOf(id) : POPULAR.length);
    return keyable.sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
  }, [list]);
  const [provider, setProvider] = useState("");
  const [key, setKey] = useState("");
  const [state, setState] = useState<{ busy?: boolean; ok?: string; error?: string }>({});
  useEffect(() => {
    if (!provider && options.length) setProvider(options[0].id);
  }, [options, provider]);

  const save = async () => {
    setState({ busy: true });
    try {
      const l = await request<ProviderInfo[]>({ cmd: "provider_key", provider, key });
      onList(l);
      const p = l.find((x) => x.id === provider);
      setKey("");
      setState({
        ok: p?.models
          ? t("Zapisano. {name}: {models} dostępnych modeli.", { name: p.name, models: p.models })
          : t("Zapisano klucz, ale dostawca nie pokazuje jeszcze modeli — sprawdź, czy klucz jest poprawny."),
      });
    } catch (e) {
      setState({ error: err(e) });
    }
  };
  const chosen = options.find((p) => p.id === provider);
  return (
    <div className="prov-form">
      <label>
        <span>{t("Dostawca")}</span>
        <select className="s-input" value={provider} onChange={(e) => setProvider(e.target.value)}>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.configured ? " ✓" : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("Klucz API")}</span>
        <input
          className="s-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          placeholder={chosen?.configured ? t("zastąp zapisany klucz") : "sk-…"}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && key.trim() && void save()}
        />
      </label>
      <div className="prov-actions">
        <span className="dim prov-hint">{t("Klucz trafia do ~/.pi/agent/auth.json, tak jak przy /login w pi.")}</span>
        <button className="btn primary" disabled={!provider || !key.trim() || state.busy} onClick={() => void save()}>
          {state.busy ? <Loader2 size={13} className="spin" /> : null} {t("Zapisz klucz")}
        </button>
      </div>
      {state.ok && <p className="settings-note ok">{state.ok}</p>}
      {state.error && <p className="settings-note err">{state.error}</p>}
    </div>
  );
}

function ServerForm({ request, onList, preset }: { request: PiRequest; onList: (l: ProviderInfo[]) => void; preset?: (typeof PRESETS)[number] }) {
  const [name, setName] = useState(preset?.name ?? "vLLM");
  const [url, setUrl] = useState(preset?.url ?? "http://localhost:8000/v1");
  const [key, setKey] = useState("");
  const [probe, setProbe] = useState<EndpointProbe | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [state, setState] = useState<{ busy?: "probe" | "add"; ok?: string; error?: string }>({});

  const check = async () => {
    setState({ busy: "probe" });
    setProbe(null);
    try {
      const p = await request<EndpointProbe>({ cmd: "endpoint_probe", baseUrl: url, apiKey: key || undefined });
      setProbe(p);
      setUrl(p.baseUrl);
      setPicked(new Set(p.models));
      setState(p.models.length ? {} : { error: t("Serwer odpowiada, ale nie zwrócił żadnych modeli.") });
    } catch (e) {
      setState({ error: err(e) });
    }
  };
  // A suggested local server is checked straight away — one click less on first run.
  useEffect(() => {
    if (preset) void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);

  const add = async () => {
    if (!probe) return;
    setState({ busy: "add" });
    try {
      const models = probe.models.filter((m) => picked.has(m));
      onList(await request<ProviderInfo[]>({ cmd: "endpoint_add", endpoint: { name, baseUrl: probe.baseUrl, apiKey: key || undefined, models, contextWindows: probe.contextWindows } }));
      setState({ ok: t("Dodano {name} — modele są już na liście w composerze.", { name }) });
      setProbe(null);
    } catch (e) {
      setState({ error: err(e) });
    }
  };
  return (
    <div className="prov-form">
      <div className="prov-presets">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            className={`chip-btn ${url === p.url ? "on" : ""}`}
            onClick={() => {
              setName(p.name);
              setUrl(p.url);
              setProbe(null);
              setState({});
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <label>
        <span>{t("Nazwa")}</span>
        <input className="s-input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        <span>{t("Adres")}</span>
        <input
          className="s-input"
          value={url}
          spellCheck={false}
          onChange={(e) => {
            setUrl(e.target.value);
            setProbe(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && void check()}
        />
      </label>
      <label>
        <span>{t("Klucz API (opcjonalnie)")}</span>
        <input className="s-input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
      </label>
      <div className="prov-actions">
        <span className="dim prov-hint">{t("Każdy serwer zgodny z API OpenAI. Dopisywany do ~/.pi/agent/models.json.")}</span>
        <button className="btn" disabled={!url.trim() || state.busy === "probe"} onClick={() => void check()}>
          {state.busy === "probe" ? <Loader2 size={13} className="spin" /> : null} {t("Sprawdź połączenie")}
        </button>
      </div>
      {probe && probe.models.length > 0 && (
        <div className="prov-models">
          <div className="prov-models-head">
            {plural(probe.models.length, ["Serwer ma {n} model", "Serwer ma {n} modele", "Serwer ma {n} modeli"], ["The server has {n} model", "The server has {n} models"])}
            {probe.llama && <span className="dim"> · llama.cpp — {t("pełne statystyki prędkości")}</span>}
            <span className="bar-spacer" />
            <button className="restore-btn" onClick={() => setPicked(picked.size === probe.models.length ? new Set() : new Set(probe.models))}>
              {picked.size === probe.models.length ? t("Odznacz wszystkie") : t("Zaznacz wszystkie")}
            </button>
          </div>
          <ul>
            {probe.models.map((m) => (
              <li key={m}>
                <label>
                  <input
                    type="checkbox"
                    checked={picked.has(m)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(m);
                      else next.delete(m);
                      setPicked(next);
                    }}
                  />
                  <span>{m}</span>
                  {probe.contextWindows[m] && <span className="dim">{Math.round(probe.contextWindows[m] / 1000)}k</span>}
                </label>
              </li>
            ))}
          </ul>
          <div className="prov-actions">
            <span className="bar-spacer" />
            <button className="btn primary" disabled={!picked.size || !name.trim() || state.busy === "add"} onClick={() => void add()}>
              {t("Dodaj serwer")}
            </button>
          </div>
        </div>
      )}
      {state.ok && <p className="settings-note ok">{state.ok}</p>}
      {state.error && <p className="settings-note err">{state.error}</p>}
    </div>
  );
}
