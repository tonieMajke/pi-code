import { useEffect, useState } from "react";
import { Check, Loader2, Mic, RefreshCw } from "lucide-react";
import type { VoiceConfig, VoiceInput, VoiceKeySource, VoiceState } from "../../shared/protocol";
import type { PiRequest } from "../lib/transport";
import { Row, Segmented, TextField, Toggle } from "./settings-ui";
import { t } from "../../shared/i18n";

/** Where the key came from, in the language the interface has right now. */
function sourceText(s: VoiceKeySource): string {
  switch (s) {
    case "stored":
      return t("zapisany w Pi Code");
    case "env":
      return t("ze zmiennej środowiskowej");
    case "pi":
      return t("z kluczy pi (auth.json)");
    case "mowa":
      return t("z MowaWszędzie (~/.config/mowa)");
    default:
      return "";
  }
}

/** Dictation languages, labelled at render time. */
const langOptions = () => [
  { value: "pl", label: t("polski") },
  { value: "en", label: t("angielski") },
  { value: "auto", label: t("wykryj") },
];

export function VoiceSection({ request }: { request: PiRequest }) {
  const [v, setV] = useState<VoiceState | null>(null);
  const [key, setKey] = useState("");
  const [test, setTest] = useState<{ busy: boolean; ok?: string; err?: string }>({ busy: false });
  const [err, setErr] = useState("");
  const [inputs, setInputs] = useState<VoiceInput[] | null>(null);
  const [probing, setProbing] = useState(false);

  const probe = () => {
    setProbing(true);
    request<VoiceInput[]>({ cmd: "voice_inputs" })
      .then(setInputs, () => setInputs([]))
      .finally(() => setProbing(false));
  };

  useEffect(() => {
    request<VoiceState>({ cmd: "voice_get" }).then(setV, (e: unknown) => setErr(String(e)));
    probe();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, [request]);

  const patch = (p: Partial<VoiceConfig>) => {
    setTest({ busy: false });
    request<VoiceState>({ cmd: "voice_set", patch: p }).then(setV, (e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  };

  if (!v) return <div className="s-empty">{err || t("wczytywanie…")}</div>;
  const c = v.config;
  const prov = v.providers.find((p) => p.id === c.provider)!;

  const saveKey = (k: string) => {
    request<VoiceState>({ cmd: "voice_key", provider: c.provider, key: k }).then((s) => {
      setV(s);
      setKey("");
      setTest({ busy: false });
    });
  };

  const runTest = () => {
    setTest({ busy: true });
    request<{ ms: number }>({ cmd: "voice_test" }).then(
      (r) => setTest({ busy: false, ok: t("Działa — serwer odpowiedział w {ms} ms.", { ms: r.ms }) }),
      (e: unknown) => setTest({ busy: false, err: e instanceof Error ? e.message : String(e) }),
    );
  };

  return (
    <>
      <h2>{t("Dyktowanie")}</h2>
      <p className="settings-note">
        {t("Mikrofon w polu wiadomości (albo Ctrl+M): mówisz, klikasz ✓ albo Enter, a tekst trafia do pola do poprawienia — nic nie wysyła się samo. Nagranie idzie do usługi transkrypcji zgodnej z OpenAI (/audio/transcriptions); lokalny GPU zostaje dla modeli.")}
      </p>
      <Row label={t("Przycisk mikrofonu")} desc={t("Pokazuj mikrofon w polu wiadomości.")}>
        <Toggle value={c.enabled} onChange={(enabled) => patch({ enabled })} />
      </Row>
      <div className="voice-mics">
        <div className="voice-mics-head">
          <span className="s-row-label">{t("Mikrofon")}</span>
          <span className="s-row-desc">{t("Pasek pokazuje, co każde wejście słyszy teraz — powiedz coś i kliknij odśwież.")}</span>
          <button className="icon-btn" onClick={probe} disabled={probing} title={t("Zmierz jeszcze raz")}>
            <RefreshCw size={14} className={probing ? "spin" : ""} />
          </button>
        </div>
        {inputs === null ? (
          <div className="s-empty">{t("słucham wejść…")}</div>
        ) : inputs.length === 0 ? (
          <div className="s-empty">{t("Nie udało się pobrać listy wejść (pactl) — nagrywa domyślne wejście systemu.")}</div>
        ) : (
          [{ name: "", label: t("Domyślne wejście systemu"), isDefault: false, level: -1, peak: -1, dead: false } as VoiceInput, ...inputs].map((m) => {
            const measured = m.name ? m : inputs.find((i) => i.isDefault);
            const dead = Boolean(measured?.dead);
            const on = c.device === m.name;
            return (
              <button key={m.name || "default"} className={`voice-mic ${on ? "on" : ""} ${dead ? "dead" : ""}`} onClick={() => !on && patch({ device: m.name })}>
                <span className="voice-mic-check">{on && <Check size={13} />}</span>
                <span className="voice-mic-name">
                  {m.label}
                  {m.isDefault && <span className="dim"> · {t("domyślne")}</span>}
                  {!m.name && measured && <span className="dim"> · {measured.label}</span>}
                </span>
                <span className="voice-mic-meter" title={dead ? t("w tej chwili równa cisza — wyciszone wejście albo odszumianie (np. EasyEffects) wycina ciszę; powiedz coś i odśwież") : undefined}>
                  {probing ? <span className="meter-busy" /> : measured && measured.level >= 0 ? <span style={{ width: `${Math.max(dead ? 0 : 6, measured.level * 100)}%` }} /> : null}
                </span>
                <span className="voice-mic-tag">{probing ? "" : dead ? t("cisza") : ""}</span>
              </button>
            );
          })
        )}
      </div>
      <Row label={t("Usługa")} desc={t("Każda przyjmuje ten sam format — zmiana to tylko adres, model i klucz.")}>
        <Segmented value={c.provider} options={v.providers.map((p) => ({ value: p.id, label: t(p.label) }))} onChange={(p) => patch({ provider: p as VoiceConfig["provider"] })} />
      </Row>
      {prov.needsKey || c.provider === "custom" ? (
        <Row
          label={t("Klucz API")}
          desc={
            prov.keySource !== "none" ? (
              <span className="voice-key-ok">
                ● {t("jest — {source}", { source: sourceText(prov.keySource) })}
              </span>
            ) : prov.needsKey ? (
              <>
                {t("Brak klucza.")} {prov.keyUrl && <span className="dim">{t("Załóż go na {url}", { url: prov.keyUrl })}</span>}
              </>
            ) : (
              t("Niepotrzebny dla lokalnego serwera bez autoryzacji.")
            )
          }
        >
          <div className="voice-key">
            <input
              className="s-input"
              type="password"
              value={key}
              placeholder={prov.keySource === "none" ? t("wklej klucz") : t("nowy klucz")}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && key.trim() && saveKey(key)}
              autoComplete="off"
              spellCheck={false}
            />
            <button className="btn primary" disabled={!key.trim()} onClick={() => saveKey(key)}>
              {t("Zapisz")}
            </button>
            {prov.keySource === "stored" && (
              <button className="btn" onClick={() => saveKey("")}>
                {t("Usuń")}
              </button>
            )}
          </div>
        </Row>
      ) : null}
      <Row label={t("Język")} desc={t("Podany wprost jest pewniejszy niż wykrywanie — krótkie zdania bywają brane za inny język.")}>
        <Segmented value={c.language} options={langOptions()} onChange={(language) => patch({ language })} />
      </Row>
      <Row label={t("Model")} desc={t("Puste = {model}", { model: prov.model })}>
        <TextField value={c.model} placeholder={prov.model} onCommit={(model) => patch({ model })} />
      </Row>
      <Row label={t("Adres API")} desc={t("Puste = {url}", { url: prov.baseUrl })}>
        <TextField value={c.baseUrl} placeholder={prov.baseUrl} onCommit={(baseUrl) => patch({ baseUrl })} />
      </Row>
      <Row
        label={t("Sprawdź połączenie")}
        desc={
          test.ok ? (
            <span className="settings-note ok">{test.ok}</span>
          ) : test.err ? (
            <span className="settings-note err">{test.err}</span>
          ) : (
            t("Wysyła pół sekundy tonu: sprawdza adres, klucz i model.")
          )
        }
      >
        <button className="btn" onClick={runTest} disabled={test.busy}>
          {test.busy ? <Loader2 size={14} className="spin" /> : <Mic size={14} />} {t("Sprawdź")}
        </button>
      </Row>
      <p className="settings-note dim">
        {v.recorder
          ? t("Nagrywa {bin} (16 kHz mono, do 12 min). Klucze API leżą w pi-gui-voice-keys.json (tylko dla Ciebie), nie w pi-gui.json.", { bin: v.recorder })
          : t("Nie znaleziono programu do nagrywania — zainstaluj pipewire (pw-record), pulseaudio-utils albo alsa-utils.")}
      </p>
    </>
  );
}
