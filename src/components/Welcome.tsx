import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Cpu, Folder, FolderOpen, Languages, Sparkles } from "lucide-react";
import type { ModelSummary, OnboardingState } from "../../shared/protocol";
import { lang, LANGS, plural, t, type Lang } from "../../shared/i18n";
import type { PiRequest } from "../lib/transport";
import { basename, formatTokens } from "../lib/format";
import { Logo } from "./Logo";
import { ProvidersPanel } from "./Providers";
import { Segmented } from "./settings-ui";

const STEP_KEY = "pi-gui.welcome-step";
const STEPS = ["lang", "model", "folder", "done"] as const;
type Step = (typeof STEPS)[number];

function savedStep(): number {
  try {
    const n = Number(sessionStorage.getItem(STEP_KEY));
    return Number.isInteger(n) && n > 0 && n < STEPS.length ? n : 0;
  } catch {
    return 0;
  }
}

function rememberStep(i: number): void {
  try {
    sessionStorage.setItem(STEP_KEY, String(i));
  } catch {
    /* no storage */
  }
}

const tilde = (p: string, home: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);

/**
 * First run: language, a model that works, the folder to work in, a few tips.
 * Everything here is also in the settings; "Pomiń" ends it at any step.
 */
export function Welcome({
  info,
  request,
  models,
  model,
  provider,
  cwd,
  projects,
  onModel,
  onDefaultModel,
  onProvidersChanged,
  onPickFolder,
  onFolder,
  onLang,
  onDone,
}: {
  info: OnboardingState;
  request: PiRequest;
  models: ModelSummary[];
  model: string;
  provider: string;
  cwd: string;
  /** Recent project folders (sessions), newest first. */
  projects: string[];
  onModel: (m: ModelSummary) => void;
  onDefaultModel: (key: string) => void;
  onProvidersChanged: () => void;
  /** Native folder dialog (typed path in the browser build); resolves to a checked path or null. */
  onPickFolder: () => Promise<string | null>;
  onFolder: (path: string) => void;
  onLang: (l: Lang) => void;
  onDone: () => void;
}) {
  const [i, setI] = useState(savedStep);
  const step: Step = STEPS[i];
  const go = (n: number) => {
    const next = Math.max(0, Math.min(STEPS.length - 1, n));
    rememberStep(next);
    setI(next);
  };
  const finish = () => {
    rememberStep(0);
    onDone();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = models.find((m) => m.id === model && m.provider === provider);
  const [folderError, setFolderError] = useState("");
  const chooseFolder = (dir: string) => {
    if (dir !== cwd) onFolder(dir);
    go(i + 1);
  };

  return (
    <div className="modal-backdrop welcome-backdrop">
      <div className="welcome" role="dialog" aria-label={t("Witaj w Pi Code")}>
        <div className="welcome-top">
          <div className="welcome-dots" aria-hidden>
            {STEPS.map((s, n) => (
              <span key={s} className={n === i ? "on" : n < i ? "done" : ""} />
            ))}
          </div>
          <button className="restore-btn" onClick={finish}>
            {t("Pomiń")}
          </button>
        </div>

        {step === "lang" && (
          <div className="welcome-step">
            <Logo size={56} className="hero-mark" />
            <h1>{t("Witaj w Pi Code")}</h1>
            <p className="welcome-lead">
              {t("Okienkowa wersja agenta pi: czaty z modelem, który czyta i zmienia pliki w Twoim projekcie. Trzy krótkie kroki i można pracować.")}
            </p>
            <div className="welcome-field">
              <Languages size={16} />
              <span>{t("Język")}</span>
              <Segmented value={lang()} options={LANGS.map((l) => ({ value: l.id, label: l.label }))} onChange={(v) => onLang(v as Lang)} />
            </div>
          </div>
        )}

        {step === "model" && (
          <div className="welcome-step left">
            <h2>
              <Cpu size={18} /> {t("Skąd brać model")}
            </h2>
            {info.localLlama && (
              <p className="settings-note ok">
                <Check size={13} /> {t("Na tym komputerze działa llama-server (localhost:8080) — Pi Code pokaże prędkość, postęp i stan GPU na żywo.")}
              </p>
            )}
            <p className="settings-note">
              {t("Możesz dodać klucz API (OpenRouter, Anthropic, OpenAI…) albo własny serwer zgodny z OpenAI (vLLM, LM Studio, Ollama). Wszystko to zmienisz później w Ustawieniach → Dostawcy modeli.")}
            </p>
            <ProvidersPanel request={request} onChanged={onProvidersChanged} compact localLlama={info.localLlama} />
            <div className="welcome-model">
              <span className="s-row-label">{t("Model na start")}</span>
              {models.length ? (
                <select
                  className="s-input"
                  value={current ? `${current.provider}/${current.id}` : ""}
                  onChange={(e) => {
                    const m = models.find((x) => `${x.provider}/${x.id}` === e.target.value);
                    if (!m) return;
                    onModel(m);
                    onDefaultModel(`${m.provider}/${m.id}`);
                  }}
                >
                  {!current && <option value="">{t("wybierz model")}</option>}
                  {models.map((m) => (
                    <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                      {m.id} · {m.provider}
                      {m.contextWindow ? ` · ${formatTokens(m.contextWindow)}` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="settings-note err">{t("Brak dostępnych modeli — dodaj dostawcę powyżej.")}</span>
              )}
            </div>
            {models.length > 0 && (
              <p className="settings-note dim">
                {plural(models.length, ["{n} dostępny model", "{n} dostępne modele", "{n} dostępnych modeli"], ["{n} model available", "{n} models available"])}.{" "}
                {t("Wybrany zostaje domyślnym dla nowych sesji; w każdej sesji możesz go zmienić chipem w polu wiadomości.")}
              </p>
            )}
          </div>
        )}

        {step === "folder" && (
          <div className="welcome-step left">
            <h2>
              <Folder size={18} /> {t("Folder roboczy")}
            </h2>
            <p className="settings-note">
              {t("Model czyta i zmienia pliki w folderze sesji — zwykle to katalog projektu. Każda sesja ma swój; zmienisz go w polu wiadomości (chip z nazwą folderu) albo w panelu Projekty.")}
            </p>
            <div className="welcome-folder current">
              <FolderOpen size={16} />
              <span className="wf-name">{basename(cwd) || cwd}</span>
              <span className="wf-path">{tilde(cwd, info.home)}</span>
              <span className="wf-tag">{t("teraz")}</span>
            </div>
            <button
              className="btn primary welcome-pick"
              onClick={async () => {
                setFolderError("");
                try {
                  const dir = await onPickFolder();
                  if (dir) chooseFolder(dir);
                } catch (e) {
                  setFolderError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              <FolderOpen size={14} /> {t("Wybierz folder…")}
            </button>
            {folderError && <p className="settings-note err">{folderError}</p>}
            {projects.filter((p) => p !== cwd).length > 0 && (
              <>
                <h3>{t("Ostatnie projekty")}</h3>
                <div className="welcome-projects">
                  {projects
                    .filter((p) => p !== cwd)
                    .slice(0, 6)
                    .map((p) => (
                      <button key={p} className="welcome-folder" onClick={() => chooseFolder(p)}>
                        <Folder size={15} />
                        <span className="wf-name">{basename(p)}</span>
                        <span className="wf-path">{tilde(p, info.home)}</span>
                      </button>
                    ))}
                </div>
              </>
            )}
          </div>
        )}

        {step === "done" && (
          <div className="welcome-step">
            <Sparkles size={34} className="welcome-spark" />
            <h1>{t("Gotowe")}</h1>
            <ul className="welcome-tips">
              <li>
                <kbd>Shift Tab</kbd> {t("tryb pracy: Pytaj → Auto-edycje → Plan → YOLO. Na start model pyta o zgodę przed każdą zmianą.")}
              </li>
              <li>
                <kbd>/</kbd> {t("komendy (kompaktowanie, fork, handoff…), a")} <kbd>@</kbd> {t("wstawia plik z projektu.")}
              </li>
              <li>
                <kbd>Ctrl P</kbd> {t("paleta: sesje, modele, akcje.")} <kbd>Ctrl K</kbd> {t("szukanie sesji.")} <kbd>Ctrl ,</kbd> {t("ustawienia.")}
              </li>
              <li>{t("Pi Code zapamiętuje trwałe fakty o Tobie (Ustawienia → Pamięć) — możesz je przejrzeć, poprawić albo wyłączyć.")}</li>
            </ul>
          </div>
        )}

        <div className="welcome-nav">
          {i > 0 && (
            <button className="btn" onClick={() => go(i - 1)}>
              <ArrowLeft size={14} /> {t("Wstecz")}
            </button>
          )}
          <span className="bar-spacer" />
          {step === "done" ? (
            <button className="btn primary" onClick={finish}>
              {t("Zaczynamy")}
            </button>
          ) : (
            <button className="btn primary" onClick={() => go(i + 1)}>
              {t("Dalej")} <ArrowRight size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
