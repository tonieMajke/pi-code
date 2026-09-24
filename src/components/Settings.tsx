import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookMarked, Plug, Brain, Bell, Box, FileText, ImagePlus, Layers, Palette, RotateCcw, RotateCw, Scale, ShieldCheck, Sparkles, Terminal, Trash2, Wrench, X } from "lucide-react";
import type { Appearance, AppearancePatch, ModelSummary, PiSettings, QueueMode, SamplingConfig, SettingsPatch, ToolPolicy } from "../../shared/protocol";
import { formatTokens } from "../lib/format";
import { NumberField, Row, Segmented, TextField, Toggle } from "./settings-ui";
import { MemorySection } from "./MemorySection";
import { ProvidersPanel } from "./Providers";
import type { PiRequest } from "../lib/transport";
import { lang, LANGS, t, type Lang } from "../../shared/i18n";
import { ACCENTS, BACKGROUNDS } from "../lib/appearance";

const SECTIONS = [
  { id: "model", label: "Model i myślenie", icon: Brain },
  { id: "providers", label: "Dostawcy modeli", icon: Plug },
  { id: "memory", label: "Pamięć", icon: BookMarked },
  { id: "constitution", label: "Konstytucja", icon: Scale },
  { id: "quality", label: "Recenzja i eskalacja", icon: ShieldCheck },
  { id: "taste", label: "Gust", icon: Sparkles },
  { id: "context", label: "Kontekst", icon: Layers },
  { id: "tools", label: "Narzędzia", icon: Wrench },
  { id: "behavior", label: "Zachowanie", icon: RotateCw },
  { id: "shell", label: "Powłoka", icon: Terminal },
  { id: "resources", label: "Rozszerzenia i skille", icon: Box },
  { id: "look", label: "Wygląd", icon: Palette },
  { id: "app", label: "Aplikacja", icon: Bell },
] as const;
export type SectionId = (typeof SECTIONS)[number]["id"];

const THINKING_LABELS: Record<string, string> = {
  off: "wył.",
  minimal: "minimalne",
  low: "niskie",
  medium: "średnie",
  high: "wysokie",
  xhigh: "b. wysokie",
};

export type AppPrefs = { notifications: boolean; closeToTray: boolean };

export function SettingsDialog({
  settings,
  models,
  model,
  provider,
  busy,
  prefs,
  onPrefs,
  onPatch,
  onCompact,
  compacting,
  appearance,
  onAppearance,
  onImage,
  imageBusy,
  onClose,
  request,
  onProvidersChanged,
  onLang,
  initialSection,
}: {
  request: PiRequest;
  onProvidersChanged: () => void;
  onLang: (l: Lang) => void;
  initialSection?: SectionId;
  settings: PiSettings | null;
  models: ModelSummary[];
  model: string;
  provider: string;
  busy: boolean;
  prefs: AppPrefs;
  onPrefs: (p: AppPrefs) => void;
  onPatch: (p: SettingsPatch) => void;
  onCompact: () => void;
  compacting: boolean;
  appearance: Appearance;
  onAppearance: (p: AppearancePatch) => void;
  /** File to import as the background picture, or null to remove it. */
  onImage: (file: File | null) => void;
  imageBusy: boolean;
  onClose: () => void;
}) {
  const [section, setSection] = useState<SectionId>(initialSection ?? "model");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const s = settings;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings" role="dialog" aria-label="Ustawienia">
        <nav className="settings-nav">
          <div className="settings-title">Ustawienia</div>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`settings-tab ${section === id ? "on" : ""}`} onClick={() => setSection(id)}>
              <Icon size={15} />
              <span>{label}</span>
            </button>
          ))}
          {s && (
            <div className="settings-file" title={s.settingsFile}>
              <FileText size={12} />
              <span>{s.settingsFile.replace(/^\/home\/[^/]+/, "~")}</span>
            </div>
          )}
        </nav>
        <div className="settings-body">
          <button className="icon-btn settings-close" onClick={onClose} title="Zamknij (Esc)">
            <X size={16} />
          </button>
          {section === "look" ? (
            <AppearanceSection a={appearance} onPatch={onAppearance} onImage={onImage} busy={imageBusy} />
          ) : section === "providers" ? (
            <>
              <h2>{t("Dostawcy modeli")}</h2>
              <p className="settings-note">
                {t("Pi Code działa z każdym dostawcą, którego obsługuje pi: lokalny llama.cpp, vLLM, LM Studio, Ollama, OpenRouter, Anthropic, OpenAI i inne. Statystyki prędkości na żywo, status GPU i limit myślenia działają tylko z llama.cpp.")}
              </p>
              <ProvidersPanel request={request} onChanged={onProvidersChanged} />
            </>
          ) : !s ? (
            <div className="s-empty">wczytywanie ustawień pi…</div>
          ) : (
            <>
              {section === "model" && (
                <>
                  <h2>Model i myślenie</h2>
                  <Row
                    label="Poziom myślenia"
                    desc={
                      s.thinking.available.length
                        ? "Dla tej sesji. Wyższy = dłuższe przemyślenia przed odpowiedzią."
                        : "pi nie steruje myśleniem tego modelu (w definicji modelu brak reasoning). Model może myśleć sam z siebie."
                    }
                  >
                    {s.thinking.available.length > 0 && (
                      <Segmented
                        value={s.thinking.level}
                        options={s.thinking.available.map((l) => ({ value: l, label: THINKING_LABELS[l] ?? l }))}
                        onChange={(v) => onPatch({ thinkingLevel: v })}
                      />
                    )}
                  </Row>
                  {s.thinking.available.length > 0 && (
                    <Row label="Domyślny poziom" desc="Dla nowych sesji (zapisywany w ustawieniach pi).">
                      <Segmented
                        value={s.thinking.defaultLevel}
                        options={s.thinking.available.map((l) => ({ value: l, label: THINKING_LABELS[l] ?? l }))}
                        onChange={(v) => onPatch({ defaultThinkingLevel: v })}
                      />
                    </Row>
                  )}
                  <Row label="Model domyślny" desc={<code>{s.defaultModel}</code>}>
                    {`${provider}/${model}` !== s.defaultModel && model && (
                      <button className="btn" onClick={() => onPatch({ defaultModel: `${provider}/${model}` })}>
                        Ustaw bieżący ({model})
                      </button>
                    )}
                  </Row>
                  <SamplingRows cfg={s.gui.sampling} onPatch={onPatch} />
                </>
              )}

              {section === "memory" && <MemorySection s={s} request={request} onPatch={onPatch} busy={busy} />}

              {section === "constitution" && <ConstitutionSection c={s.constitution} onPatch={onPatch} />}

              {section === "quality" && <QualitySection s={s} models={models} onPatch={onPatch} />}
              {section === "taste" && <TasteSection s={s} models={models} onPatch={onPatch} />}

              {section === "context" && (
                <>
                  <h2>Kontekst</h2>
                  <Row label="Kompaktuj teraz" desc="Streszcza starszą część rozmowy, żeby zwolnić miejsce w kontekście.">
                    <button className="btn" disabled={busy || compacting} onClick={onCompact}>
                      {compacting ? "Kompaktuję…" : "Kompaktuj"}
                    </button>
                  </Row>
                  <Row label="Automatyczne kompaktowanie" desc="Gdy kontekst się zapełnia, pi sam streszcza starsze wiadomości.">
                    <Toggle value={s.compaction.enabled} onChange={(v) => onPatch({ compactionEnabled: v })} />
                  </Row>
                  <Row
                    label="Kompaktuj od (bieżący model)"
                    desc={`Mniejsze modele gubią się w długim kontekście dużo wcześniej niż kończy się okno (${formatTokens(s.contextWindow)}). 0 = domyślnie pi. Teraz: ${formatTokens(s.compactAt)}.`}
                  >
                    <NumberField value={s.compactAt} min={0} max={s.contextWindow} step={10000} onCommit={(v) => onPatch({ compactAt: v })} />
                  </Row>
                  <Row
                    label="Skracaj stare wyniki narzędzi"
                    desc="Duże wyniki (logi, całe pliki) z wcześniejszych poleceń zamieniane na początek + notkę. Bieżące zadanie zawsze widzi wszystko; model może uruchomić narzędzie ponownie."
                  >
                    <Toggle value={s.gui.context.elideOldToolOutput} onChange={(v) => onPatch({ context: { elideOldToolOutput: v } })} />
                  </Row>
                  {s.gui.context.elideOldToolOutput && (
                    <Row label="Skracaj powyżej (znaków)" desc="Wyniki krótsze zostają w całości.">
                      <NumberField value={s.gui.context.elideAboveChars} min={200} step={500} onCommit={(v) => onPatch({ context: { elideAboveChars: v } })} />
                    </Row>
                  )}
                  <Row
                    label="Rezerwa tokenów"
                    desc={`Kompaktuj, gdy do końca okna zostanie mniej niż tyle (${formatTokens(s.compaction.reserveTokens)}).`}
                  >
                    <NumberField value={s.compaction.reserveTokens} min={1000} step={1000} onCommit={(v) => onPatch({ reserveTokens: v })} />
                  </Row>
                  <Row
                    label="Zachowaj najnowsze"
                    desc={`Tyle tokenów ostatniej rozmowy zostaje dosłownie, reszta idzie do streszczenia (${formatTokens(s.compaction.keepRecentTokens)}).`}
                  >
                    <NumberField value={s.compaction.keepRecentTokens} min={1000} step={1000} onCommit={(v) => onPatch({ keepRecentTokens: v })} />
                  </Row>
                  <Row label="Pliki kontekstu" desc="AGENTS.md / CLAUDE.md wczytane do promptu systemowego tej sesji.">
                    <span />
                  </Row>
                  <ul className="settings-list">
                    {s.contextFiles.length === 0 && <li className="dim">brak</li>}
                    {s.contextFiles.map((f) => (
                      <li key={f}>
                        <code>{f.replace(/^\/home\/[^/]+/, "~")}</code>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {section === "tools" && <ToolsSection s={s} onPatch={onPatch} />}

              {section === "behavior" && (
                <>
                  <h2>Zachowanie</h2>
                  <Row label="Steering w trakcie pracy" desc="Wskazówki wysłane, gdy model pracuje: dostarczane wszystkie naraz albo po jednej na krok.">
                    <QueueSelect value={s.steeringMode} onChange={(v) => onPatch({ steeringMode: v })} />
                  </Row>
                  <Row label="Wiadomości w kolejce" desc="Follow-upy czekające na koniec odpowiedzi.">
                    <QueueSelect value={s.followUpMode} onChange={(v) => onPatch({ followUpMode: v })} />
                  </Row>
                  <Row label="Ponawianie błędów" desc="Automatyczny retry, gdy dostawca modelu zwróci błąd przejściowy.">
                    <Toggle value={s.retry.enabled} onChange={(v) => onPatch({ retryEnabled: v })} />
                  </Row>
                  <Row label="Maks. prób" desc="Ile razy ponowić jedno zapytanie.">
                    <NumberField value={s.retry.maxRetries} min={0} max={20} onCommit={(v) => onPatch({ maxRetries: v })} />
                  </Row>
                  <Row label="Opóźnienie bazowe (ms)" desc="Czas przed pierwszą ponowną próbą; kolejne rosną wykładniczo.">
                    <NumberField value={s.retry.baseDelayMs} min={100} step={500} onCommit={(v) => onPatch({ baseDelayMs: v })} />
                  </Row>
                  <Row label="Zmniejszaj obrazy" desc="Duże załączniki są skalowane przed wysłaniem do modelu.">
                    <Toggle value={s.images.autoResize} onChange={(v) => onPatch({ imageAutoResize: v })} />
                  </Row>
                  <Row label="Blokuj obrazy" desc="Nie wysyłaj obrazów do modelu wcale.">
                    <Toggle value={s.images.blockImages} onChange={(v) => onPatch({ blockImages: v })} />
                  </Row>
                </>
              )}

              {section === "shell" && (
                <>
                  <h2>Powłoka</h2>
                  <p className="settings-note">Dotyczy narzędzia bash. Zmiany działają od następnej sesji.</p>
                  <Row label="Ścieżka powłoki" desc="Pusto = domyślna (bash).">
                    <TextField value={s.shellPath} placeholder="/bin/bash" onCommit={(v) => onPatch({ shellPath: v })} />
                  </Row>
                  <Row label="Prefiks komend" desc="Doklejany przed każdą komendą, np. aktywacja środowiska.">
                    <TextField
                      value={s.shellCommandPrefix}
                      placeholder="source .venv/bin/activate &&"
                      onCommit={(v) => onPatch({ shellCommandPrefix: v })}
                    />
                  </Row>
                </>
              )}

              {section === "resources" && (
                <>
                  <h2>Rozszerzenia i skille</h2>
                  <p className="settings-note">
                    Wczytane przez pi dla tej sesji. Instalacja i usuwanie: <code>pi install</code> w terminalu.
                  </p>
                  <h3>Rozszerzenia ({s.extensions.length})</h3>
                  <ul className="settings-list">
                    {s.extensions.length === 0 && <li className="dim">brak</li>}
                    {s.extensions.map((e) => (
                      <li key={e.path} title={e.path}>
                        <span>{e.name}</span>
                        {e.source !== e.name && <span className="dim">{e.source}</span>}
                      </li>
                    ))}
                  </ul>
                  <h3>Skille ({s.skills.length})</h3>
                  <ul className="settings-list">
                    {s.skills.length === 0 && <li className="dim">brak</li>}
                    {s.skills.map((k) => (
                      <li key={k.name}>
                        <span>{k.name}</span>
                        <span className="dim clamp">{k.description}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {section === "app" && (
                <>
                  <h2>Aplikacja</h2>
                  <Row label={t("Język")} desc={t("Język interfejsu. Po zmianie okno przeładuje się.")}>
                    <Segmented value={lang()} options={LANGS.map((l) => ({ value: l.id, label: l.label }))} onChange={(v) => onLang(v as Lang)} />
                  </Row>
                  <Row label="Powiadomienia" desc="Systemowe powiadomienie, gdy pi skończy albo czeka na zgodę, a okno jest w tle.">
                    <Toggle value={prefs.notifications} onChange={(v) => onPrefs({ ...prefs, notifications: v })} />
                  </Row>
                  <Row label="Zamykanie chowa do zasobnika" desc="Przycisk zamknięcia chowa okno do zasobnika systemowego, a pi pracuje dalej. Zakończ aplikację z menu ikony w zasobniku.">
                    <Toggle value={prefs.closeToTray} onChange={(v) => onPrefs({ ...prefs, closeToTray: v })} />
                  </Row>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function QueueSelect({ value, onChange }: { value: QueueMode; onChange: (v: QueueMode) => void }) {
  return (
    <Segmented
      value={value}
      options={[
        { value: "one-at-a-time", label: "po jednej" },
        { value: "all", label: "wszystkie" },
      ]}
      onChange={(v) => onChange(v as QueueMode)}
    />
  );
}

function ConstitutionSection({
  c,
  onPatch,
}: {
  c: PiSettings["constitution"];
  onPatch: (p: SettingsPatch) => void;
}) {
  const saved = c.text.trim() || c.defaultText;
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const dirty = draft.trim() !== saved.trim();
  const isDefault = !c.text.trim();
  const save = () => onPatch({ constitution: { text: draft.trim() === c.defaultText.trim() ? "" : draft } });
  return (
    <>
      <h2>Konstytucja</h2>
      <p className="settings-note">
        Stałe zasady pracy dla modelu: najpierw zrozum i przeczytaj, potem mały krok, potem sprawdzenie, poprawka,
        znowu sprawdzenie. Szczególnie pomaga mniejszym modelom, które gubią wątek albo ogłaszają sukces bez
        sprawdzenia.
      </p>
      <Row label="Konstytucja włączona" desc="Zasady są dopisywane do promptu systemowego przy każdej wiadomości.">
        <Toggle value={c.enabled} onChange={(v) => onPatch({ constitution: { enabled: v } })} />
      </Row>
      <Row
        label="Twarde strażniki"
        desc={
          <>
            Egzekwowane w kodzie, a nie tylko proszone:
            <ul className="guard-list">
              <li>blokada edycji albo nadpisania pliku, którego model w tej sesji nie przeczytał,</li>
              <li>blokada powtórzenia tego samego wywołania, które już dwa razy padło,</li>
              <li>
                model nie może skończyć pracy, jeśli zmienił kod i nic nie sprawdził (testy, typecheck, build,
                uruchomienie) albo jeśli ostatnie sprawdzenie nie przeszło. Zostaje odesłany do pracy.
              </li>
            </ul>
          </>
        }
      >
        <Toggle value={c.hard} onChange={(v) => onPatch({ constitution: { hard: v } })} />
      </Row>
      <Row label="Maks. odesłań na zadanie" desc="Ile razy strażnik może zawrócić model w jednej odpowiedzi, zanim odpuści.">
        <NumberField value={c.maxNudges} min={0} max={10} onCommit={(v) => onPatch({ constitution: { maxNudges: v } })} />
      </Row>
      <h3>Treść {isDefault && !dirty && <span className="dim">(domyślna)</span>}</h3>
      <textarea
        className="constitution-text"
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="constitution-actions">
        <span title={c.file}>{c.file.replace(/^\/home\/[^/]+/, "~")}</span>
        <span className="spacer" />
        {!isDefault && (
          <button className="btn" onClick={() => onPatch({ constitution: { text: "" } })}>
            Przywróć domyślną
          </button>
        )}
        {dirty && (
          <button className="btn" onClick={() => setDraft(saved)}>
            Anuluj
          </button>
        )}
        <button className="btn primary" disabled={!dirty} onClick={save}>
          Zapisz
        </button>
      </div>
    </>
  );
}

const POLICY_OPTIONS = [
  { value: "always", label: "zawsze" },
  { value: "deferred", label: "na żądanie" },
  { value: "off", label: "wył." },
];

function ToolsSection({ s, onPatch }: { s: PiSettings; onPatch: (p: SettingsPatch) => void }) {
  const always = s.tools.filter((t) => t.policy === "always");
  const deferred = s.tools.filter((t) => t.policy === "deferred");
  const loaded = deferred.filter((t) => t.active);
  const cost = (list: typeof s.tools) => list.reduce((a, t) => a + t.tokens, 0);
  const order: Record<ToolPolicy, number> = { always: 0, deferred: 1, off: 2 };
  const sorted = [...s.tools].sort((a, b) => order[a.policy] - order[b.policy] || b.tokens - a.tokens);
  return (
    <>
      <h2>Narzędzia</h2>
      <p className="settings-note">
        <b>Zawsze</b>: pełny opis w każdym zapytaniu. <b>Na żądanie</b>: model widzi tylko nazwę i jedno zdanie, a gdy
        narzędzie jest potrzebne, sam je ładuje (<code>enable_tools</code>) i ma je od następnego kroku. Mniej
        narzędzi w kontekście to mniej pomyłek małego modelu. O zatwierdzaniu decyduje tryb uprawnień (Shift+Tab).
      </p>
      <div className="tool-budget">
        <span>
          W każdym zapytaniu: <b>~{formatTokens(cost(always) + cost(loaded))}</b> tok.
        </span>
        <span className="dim">
          {deferred.length} na żądanie (~{formatTokens(cost(deferred))} tok. gdyby wszystkie były zawsze)
          {loaded.length > 0 && ` · w tej sesji załadowane: ${loaded.map((t) => t.name).join(", ")}`}
        </span>
      </div>
      {sorted.map((t) => (
        <Row
          key={t.name}
          label={
            <>
              <code>{t.name}</code> <span className="dim tool-tokens">~{formatTokens(t.tokens)} tok.</span>
            </>
          }
          desc={
            <>
              <span className="clamp">{t.description}</span>
              <span className="dim"> · {t.source}</span>
            </>
          }
        >
          <Segmented
            value={t.policy}
            options={POLICY_OPTIONS}
            onChange={(v) => onPatch({ toolPolicy: { name: t.name, policy: v as ToolPolicy } })}
          />
        </Row>
      ))}
    </>
  );
}

function ModelSelect({
  value,
  models,
  empty,
  onChange,
}: {
  value: string;
  models: ModelSummary[];
  empty: string;
  onChange: (v: string) => void;
}) {
  return (
    <select className="s-input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {models.map((m) => (
        <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
          {m.id}
        </option>
      ))}
    </select>
  );
}

function QualitySection({
  s,
  models,
  onPatch,
}: {
  s: PiSettings;
  models: ModelSummary[];
  onPatch: (p: SettingsPatch) => void;
}) {
  const g = s.gui;
  return (
    <>
      <h2>Recenzja i eskalacja</h2>
      <Row
        label="Niezależna recenzja zmian"
        desc="Zanim model skończy, drugi przebieg widzi tylko zadanie i diff (bez rozumowania autora) i szuka błędów. Uwagi wracają do modelu do poprawy. Raz na odpowiedź."
      >
        <Toggle value={g.review.enabled} onChange={(v) => onPatch({ review: { enabled: v } })} />
      </Row>
      {g.review.enabled && (
        <Row
          label="Model recenzenta"
          desc="Inny model = świeże spojrzenie, ale router musi go załadować (VRAM, czas). Ten sam = szybko."
        >
          <ModelSelect value={g.review.model} models={models} empty="ten sam co sesja" onChange={(v) => onPatch({ review: { model: v } })} />
        </Row>
      )}
      {g.review.enabled && (
        <Row
          label="Recenzuj od"
          desc="Mała zmiana, którą model już sprawdził testem, nie idzie do recenzji — to głównie koszt czasu. Liczone w zmienionych liniach."
        >
          <Segmented
            value={String(g.review.minLines ?? 40)}
            options={[
              { value: "0", label: "zawsze" },
              { value: "20", label: "20 linii" },
              { value: "40", label: "40 linii" },
              { value: "100", label: "100 linii" },
            ]}
            onChange={(v) => onPatch({ review: { minLines: Number(v) } })}
          />
        </Row>
      )}
      <Row
        label="Model do eskalacji"
        desc="Gdy strażnik wyczerpie odesłania albo model kręci się w kółko, pojawi się przycisk przekazania zadania temu modelowi."
      >
        <ModelSelect value={g.escalation.model} models={models} empty="wyłączona" onChange={(v) => onPatch({ escalation: { model: v } })} />
      </Row>
      {g.escalation.model && (
        <Row label="Wróć do poprzedniego modelu" desc="Po zakończeniu eskalowanej odpowiedzi sesja wraca do modelu, który utknął.">
          <Toggle value={g.escalation.revert} onChange={(v) => onPatch({ escalation: { revert: v } })} />
        </Row>
      )}
    </>
  );
}

export function TasteSection({ s, models, onPatch }: { s: PiSettings; models: ModelSummary[]; onPatch: (p: SettingsPatch) => void }) {
  const t = s.gui.taste;
  // A sidecar started before this version doesn't send the section yet.
  if (!t) return <p className="s-row-desc">Uruchom ponownie sidecar (nowa wersja), żeby zobaczyć te ustawienia.</p>;
  const critic = t.criticModel ? models.find((m) => `${m.provider}/${m.id}` === t.criticModel) : null;
  const sees = t.criticModel ? !!critic?.vision : s.modelVision;
  return (
    <>
      <h2>Gust</h2>
      <Row
        label="Pętla gustu"
        desc="Przy pracy wizualnej (strony, SVG, modele 3D): najpierw wzorce, potem budowanie, pomiar strony i krytyk ze świeżym spojrzeniem, zanim model skończy."
      >
        <Toggle value={t.enabled} onChange={(v) => onPatch({ taste: { enabled: v } })} />
      </Row>
      {t.enabled && (
        <>
          <Row
            label="Szukanie wzorców"
            desc="Przed pierwszą zmianą wizualną model szuka inspiracji: stron podobnych do tej, którą robi, albo obrazów tematu (np. goblin do modelu 3D). Za każdym razem inne; słabe strony odpadają w pomiarze. Obraz dołączony do wiadomości zastępuje szukanie."
          >
            <Segmented
              value={t.research}
              options={[
                { value: "auto", label: "samo" },
                { value: "ask", label: "pytaj" },
                { value: "off", label: "wył." },
              ]}
              onChange={(v) => onPatch({ taste: { research: v as typeof t.research } })}
            />
          </Row>
          <Row
            label="Wymagaj czystego ui_audit"
            desc="Po zmianie strony model musi ją zmierzyć (kontrast, odstępy, wyrównanie, przepełnienie przy 390 px) i poprawić poważne problemy."
          >
            <Toggle value={t.requireAudit} onChange={(v) => onPatch({ taste: { requireAudit: v } })} />
          </Row>
          <Row
            label="Krytyk"
            desc="Na końcu osobna sesja bez historii i bez rozumowania autora porównuje wynik ze wzorcem i wypisuje konkretne różnice. Uwagi wracają do modelu."
          >
            <Toggle value={t.critic} onChange={(v) => onPatch({ taste: { critic: v } })} />
          </Row>
          {t.critic && (
            <>
              <Row
                label="Model krytyka"
                desc={
                  sees
                    ? "Widzi obrazy: porównuje zrzut ze wzorcem."
                    : "Ten model nie widzi obrazów: przy stronach dostaje pomiary i zarys strony, przy 3D krytyk się nie uruchomi."
                }
              >
                <ModelSelect value={t.criticModel} models={models} empty="ten sam co sesja" onChange={(v) => onPatch({ taste: { criticModel: v } })} />
              </Row>
              <Row label="Rundy krytyka" desc="Ile razy krytyk może odesłać wynik do poprawki w jednej odpowiedzi.">
                <Segmented
                  value={String(t.maxRounds)}
                  options={["1", "2", "3", "4", "5"].map((v) => ({ value: v, label: v }))}
                  onChange={(v) => onPatch({ taste: { maxRounds: Number(v) } })}
                />
              </Row>
              <Row
                label="Osobny slot llama.cpp"
                desc="Krytyk na slocie 1, żeby nie wypierał z pamięci kontekstu rozmowy (bez tego następna tura przelicza cały prompt). Wymaga serwera z --parallel 2 lub więcej."
              >
                <Toggle value={t.criticSlot !== null} onChange={(v) => onPatch({ taste: { criticSlot: v ? 1 : null } })} />
              </Row>
            </>
          )}
          <Row label="Własna galeria" desc="Zrzuty i obrazy, które lubisz, w ~/.pi/agent/design-refs/ (podkatalogi dowolne). Używane, gdy sieć nic nie da albo nie ma sieci.">
            <span className="s-row-desc">~/.pi/agent/design-refs</span>
          </Row>
        </>
      )}
    </>
  );
}

const SAMPLING_FIELDS: { key: keyof Omit<SamplingConfig, "enabled" | "reasoning_budget_tokens">; label: string; step: number; hint: string }[] = [
  { key: "temperature", label: "temperature", step: 0.05, hint: "kod: 0.2–0.7" },
  { key: "top_p", label: "top_p", step: 0.05, hint: "np. 0.95" },
  { key: "top_k", label: "top_k", step: 1, hint: "np. 20" },
  { key: "min_p", label: "min_p", step: 0.01, hint: "np. 0" },
  { key: "presence_penalty", label: "presence_penalty", step: 0.1, hint: "przeciw pętlom: 0–1.5" },
  { key: "repeat_penalty", label: "repeat_penalty", step: 0.01, hint: "1 = wył." },
];

function SamplingRows({ cfg, onPatch }: { cfg: SamplingConfig; onPatch: (p: SettingsPatch) => void }) {
  return (
    <>
      <Row
        label="Limit myślenia na turę"
        desc="Ile tokenów model może myśleć przed jednym krokiem; potem musi działać. Małe modele potrafią przemyśliwać proste kroki tysiącami tokenów. W evalu 4096 dało ten sam wynik ~15% szybciej."
      >
        <Segmented
          value={String(cfg.reasoning_budget_tokens ?? 0)}
          options={[
            { value: "0", label: "bez limitu" },
            { value: "2048", label: "2k" },
            { value: "4096", label: "4k" },
            { value: "8192", label: "8k" },
          ]}
          onChange={(v) => onPatch({ sampling: { reasoning_budget_tokens: Number(v) || null } })}
        />
      </Row>
      <Row
        label="Własne parametry próbkowania"
        desc="Nadpisuje preset routera dla każdego zapytania do lokalnego modelu (konfiguracja routera zostaje bez zmian). Puste pole = wartość z presetu."
      >
        <Toggle value={cfg.enabled} onChange={(v) => onPatch({ sampling: { enabled: v } })} />
      </Row>
      {cfg.enabled && (
        <div className="sampling-grid">
          {SAMPLING_FIELDS.map((f) => (
            <label key={f.key}>
              <span>{f.label}</span>
              <OptionalNumber value={cfg[f.key]} step={f.step} placeholder={f.hint} onCommit={(v) => onPatch({ sampling: { [f.key]: v } })} />
            </label>
          ))}
        </div>
      )}
    </>
  );
}

/** Number or empty (= null). */
function OptionalNumber({
  value,
  step,
  placeholder,
  onCommit,
}: {
  value: number | null;
  step: number;
  placeholder: string;
  onCommit: (v: number | null) => void;
}) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  useEffect(() => setDraft(value === null ? "" : String(value)), [value]);
  const commit = () => {
    const t = draft.trim().replace(",", ".");
    const n = t === "" ? null : Number(t);
    if (n !== null && !Number.isFinite(n)) return setDraft(value === null ? "" : String(value));
    if (n !== value) onCommit(n);
  };
  return (
    <input
      className="s-input num"
      inputMode="decimal"
      value={draft}
      step={step}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

export function AppearanceSection({
  a,
  onPatch,
  onImage,
  busy,
}: {
  a: Appearance;
  onPatch: (p: AppearancePatch) => void;
  onImage: (file: File | null) => void;
  busy: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const custom = a.accent !== null || a.background !== null || a.imageUrl !== null || a.theme !== "system";
  return (
    <>
      <h2>Wygląd</h2>
      <Row
        label="Motyw"
        desc={a.background ? "Ustala go teraz kolor tła (jasne tło → jasny motyw), żeby tekst był czytelny." : undefined}
      >
        <Segmented
          value={a.theme}
          options={[
            { value: "system", label: "systemowy" },
            { value: "dark", label: "ciemny" },
            { value: "light", label: "jasny" },
          ]}
          onChange={(v) => onPatch({ theme: v as Appearance["theme"] })}
        />
      </Row>
      <Row label="Kolor akcentu" desc="Przyciski, zaznaczenia, ikony. Logo zostaje w kolorze marki.">
        <Swatches colors={ACCENTS} value={a.accent} onChange={(accent) => onPatch({ accent })} />
      </Row>
      <Row label="Kolor tła" desc="Z niego liczone są panele, dymki i bloki kodu.">
        <Swatches colors={BACKGROUNDS} value={a.background} onChange={(background) => onPatch({ background })} />
      </Row>
      <Row label="Obraz tła" desc="Zdjęcie pod całym oknem. Zapisywane zmniejszone (maks. 2560 px) obok ustawień pi.">
        <div className="bg-pick">
          {a.imageUrl && <img className="bg-thumb" src={a.imageUrl} alt="" />}
          <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
            <ImagePlus size={14} />
            {busy ? "wczytywanie…" : a.imageUrl ? "Zmień…" : "Wybierz obraz…"}
          </button>
          {a.imageUrl && (
            <button className="icon-btn" title="Usuń obraz" onClick={() => onImage(null)}>
              <Trash2 size={15} />
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) onImage(f);
            }}
          />
        </div>
      </Row>
      {a.imageUrl && (
        <>
          <Row label="Przyciemnienie obrazu" desc="Ile koloru tła kłaść na zdjęcie — wyżej = czytelniejszy tekst.">
            <Slider value={a.image.dim} min={0} max={0.95} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(dim) => onPatch({ image: { dim } })} />
          </Row>
          <Row label="Rozmycie obrazu">
            <Slider value={a.image.blur} min={0} max={40} step={1} format={(v) => `${v} px`} onChange={(blur) => onPatch({ image: { blur } })} />
          </Row>
        </>
      )}
      <Row label="Przywróć domyślny wygląd">
        <button
          className="btn"
          disabled={!custom}
          onClick={() => {
            onPatch({ theme: "system", accent: null, background: null, image: { dim: 0.55, blur: 0 } });
            if (a.imageUrl) onImage(null);
          }}
        >
          <RotateCcw size={14} />
          Resetuj
        </button>
      </Row>
    </>
  );
}

/** Preset colours + a custom picker; the first "auto" dot = theme default (null). */
function Swatches({ colors, value, onChange }: { colors: string[]; value: string | null; onChange: (v: string | null) => void }) {
  const isCustom = value !== null && !colors.includes(value);
  return (
    <div className="swatches">
      <button className={`swatch auto ${value === null ? "on" : ""}`} title="Domyślny motywu" onClick={() => onChange(null)} />
      {colors.map((c) => (
        <button key={c} className={`swatch ${value === c ? "on" : ""}`} style={{ background: c }} title={c} onClick={() => onChange(c)} />
      ))}
      <label className={`swatch custom ${isCustom ? "on" : ""}`} title="Własny kolor" style={isCustom ? { background: value } : undefined}>
        <input type="color" value={value ?? "#808080"} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  );
}

function Slider({
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="slider">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="slider-val">{format(value)}</span>
    </div>
  );
}
