import { useEffect, useMemo, useRef, useState } from "react";
import { Check, FileText, Pencil, Plus, Search, Sparkles, Trash2, X } from "lucide-react";
import type { MemoryEntry, MemoryState, PiSettings, SettingsPatch } from "../../shared/protocol";
import { plural, t } from "../../shared/i18n";
import type { PiRequest } from "../lib/transport";
import { Row, Toggle } from "./settings-ui";

const tilde = (p: string) => p.replace(/^\/home\/[^/]+/, "~");

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Settings → Memory: what the model remembers about the user (edit, delete, add),
 * the two switches, and the instruction files (AGENTS.md) that go into every prompt.
 */
export function MemorySection({
  s,
  request,
  onPatch,
  busy,
}: {
  s: PiSettings;
  request: PiRequest;
  onPatch: (p: SettingsPatch) => void;
  busy: boolean;
}) {
  const [state, setState] = useState<MemoryState | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [learning, setLearning] = useState(false);
  const [note, setNote] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const load = () => request<MemoryState>({ cmd: "memory_get" }).then(setState, fail);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = (entries: MemoryEntry[]) => {
    setError("");
    setState((st) => (st ? { ...st, entries } : st)); // optimistic; the reply has the stored ids
    request<MemoryState>({ cmd: "memory_set", entries }).then(setState, fail);
  };

  const entries = state?.entries ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? entries.filter((e) => e.text.toLowerCase().includes(q)) : entries;
    return [...list].reverse(); // newest first, like Claude
  }, [entries, query]);

  const learn = async () => {
    setLearning(true);
    setNote("");
    setError("");
    try {
      const { added } = await request<{ added: MemoryEntry[] }>({ cmd: "memory_learn" });
      setNote(added.length ? plural(added.length, ["Zapamiętano {n} nowy fakt.", "Zapamiętano {n} nowe fakty.", "Zapamiętano {n} nowych faktów."], ["Remembered {n} new fact.", "Remembered {n} new facts."]) : t("Nic nowego do zapamiętania w tej rozmowie."));
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setLearning(false);
    }
  };

  const cfg = s.gui.memory;
  return (
    <>
      <h2>{t("Pamięć")}</h2>
      <p className="settings-note">
        {t("Krótkie fakty o Tobie, które model dostaje na początku każdej sesji: preferencje, sprzęt, projekty, sposób pracy. Możesz je poprawiać i usuwać.")}
      </p>
      {state?.external && (
        <p className="settings-note warn">
          {t("Pamięcią zajmuje się teraz rozszerzenie {path}. Wbudowana pamięć Pi Code jest wyłączona, żeby nic się nie dublowało — usuń to rozszerzenie, żeby z niej korzystać.", { path: tilde(state.external) })}
        </p>
      )}
      <Row label={t("Używaj pamięci")} desc={t("Zapamiętane fakty trafiają do promptu systemowego każdej sesji. Model może też sam zapisać fakt, gdy poprosisz „zapamiętaj, że…”.")}>
        <Toggle value={cfg.enabled} onChange={(v) => onPatch({ memory: { enabled: v } })} />
      </Row>
      <Row
        label={t("Ucz się z rozmów")}
        desc={t("Gdy przechodzisz do innej sesji, model przegląda poprzednią rozmowę i dopisuje nowe trwałe fakty. Nie w trakcie pracy — lokalny serwer ma zwykle jeden slot i straciłby cache rozmowy.")}
      >
        <Toggle value={cfg.learn} onChange={(v) => onPatch({ memory: { learn: v } })} />
      </Row>

      <div className="mem-head">
        <h3>
          {t("Zapamiętane")} {state && <span className="dim">({entries.length})</span>}
        </h3>
        <span className="bar-spacer" />
        <button className="btn" disabled={busy || learning || !cfg.enabled || Boolean(state?.external)} onClick={learn} title={t("Przejrzyj bieżącą rozmowę i dopisz nowe fakty")}>
          <Sparkles size={13} /> {learning ? t("Czytam rozmowę…") : t("Zapamiętaj z tej rozmowy")}
        </button>
        <button className="btn" onClick={() => setAdding(true)} disabled={adding}>
          <Plus size={13} /> {t("Dodaj")}
        </button>
      </div>
      {note && <p className="settings-note ok">{note}</p>}
      {error && <p className="settings-note err">{error}</p>}
      {entries.length > 8 && (
        <label className="mem-search">
          <Search size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("Szukaj w pamięci")} />
        </label>
      )}
      <ul className="mem-list">
        {adding && (
          <EntryEditor
            initial=""
            placeholder={t("np. Wolę krótkie odpowiedzi po polsku.")}
            onSave={(text) => {
              setAdding(false);
              if (text) save([...entries, { id: `new-${Date.now()}`, date: today(), text }]);
            }}
            onCancel={() => setAdding(false)}
          />
        )}
        {state && !entries.length && !adding && (
          <li className="mem-empty">
            {cfg.learn ? t("Pamięć jest pusta. Wypełni się po kilku rozmowach albo dodaj coś ręcznie.") : t("Pamięć jest pusta.")}
          </li>
        )}
        {!state && !error && <li className="mem-empty">{t("wczytywanie…")}</li>}
        {shown.map((e) =>
          editing === e.id ? (
            <EntryEditor
              key={e.id}
              initial={e.text}
              onSave={(text) => {
                setEditing(null);
                if (text && text !== e.text) save(entries.map((x) => (x.id === e.id ? { ...x, text } : x)));
                else if (!text) save(entries.filter((x) => x.id !== e.id));
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <li key={e.id} className="mem-item">
              <span className="mem-text" onDoubleClick={() => setEditing(e.id)}>
                {e.text}
              </span>
              {e.date && <span className="mem-date">{e.date}</span>}
              <button className="icon-btn" title={t("Edytuj")} onClick={() => setEditing(e.id)}>
                <Pencil size={13} />
              </button>
              <button className="icon-btn danger" title={t("Usuń")} onClick={() => save(entries.filter((x) => x.id !== e.id))}>
                <Trash2 size={13} />
              </button>
            </li>
          ),
        )}
      </ul>
      {state && entries.length > 0 && (
        <div className="mem-foot">
          <span className="settings-file" title={state.file}>
            <FileText size={12} /> <span>{tilde(state.file)}</span>
          </span>
          <span className="bar-spacer" />
          <button
            className={`btn ${confirmClear ? "danger" : ""}`}
            onClick={() => {
              if (!confirmClear) {
                setConfirmClear(true);
                setTimeout(() => setConfirmClear(false), 3000);
                return;
              }
              setConfirmClear(false);
              save([]);
            }}
          >
            {confirmClear ? t("Kliknij jeszcze raz, żeby wyczyścić") : t("Wyczyść pamięć")}
          </button>
        </div>
      )}

      {state && (
        <>
          <h3>{t("Instrukcje")}</h3>
          <p className="settings-note">
            {t("Pliki AGENTS.md są doklejane do promptu systemowego w całości — to stałe zasady, które piszesz sam. Globalny działa we wszystkich projektach, projektowy tylko w swoim folderze.")}
          </p>
          <AgentsEditor
            label={t("Globalne (wszystkie projekty)")}
            path={state.agents.global.path}
            text={state.agents.global.text}
            onSave={(text) => request<MemoryState>({ cmd: "agents_set", scope: "global", text }).then(setState, fail)}
          />
          {state.agents.project ? (
            <AgentsEditor
              label={t("Ten projekt")}
              path={state.agents.project.path}
              text={state.agents.project.text}
              missing={!state.agents.project.exists}
              onSave={(text) => request<MemoryState>({ cmd: "agents_set", scope: "project", text }).then(setState, fail)}
            />
          ) : (
            <p className="settings-note dim">{t("Ta sesja nie ma folderu projektu — instrukcje projektu pojawią się, gdy otworzysz sesję w folderze.")}</p>
          )}
        </>
      )}
    </>
  );
}

function EntryEditor({
  initial,
  placeholder,
  onSave,
  onCancel,
}: {
  initial: string;
  placeholder?: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const commit = () => onSave(draft.replace(/\s+/g, " ").trim());
  return (
    <li className="mem-item editing">
      <textarea
        ref={ref}
        className="s-input mem-edit"
        rows={2}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <button className="icon-btn" title={t("Zapisz (Enter)")} onClick={commit}>
        <Check size={14} />
      </button>
      <button className="icon-btn" title={t("Anuluj (Esc)")} onClick={onCancel}>
        <X size={14} />
      </button>
    </li>
  );
}

function AgentsEditor({
  label,
  path,
  text,
  missing,
  onSave,
}: {
  label: string;
  path: string;
  text: string;
  missing?: boolean;
  onSave: (text: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(text);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(text), [text]);
  const dirty = draft !== text;
  return (
    <div className="agents-editor">
      <div className="agents-head">
        <span className="s-row-label">{label}</span>
        <code className="dim" title={path}>
          {tilde(path)}
          {missing ? ` — ${t("jeszcze nie istnieje")}` : ""}
        </code>
      </div>
      <textarea
        className="s-input constitution-text"
        rows={Math.min(14, Math.max(4, draft.split("\n").length + 1))}
        value={draft}
        placeholder={t("np. Odpowiadaj po polsku. Testy uruchamiaj przez pnpm test.")}
        onChange={(e) => setDraft(e.target.value)}
      />
      {dirty && (
        <div className="agents-actions">
          <button className="btn" onClick={() => setDraft(text)}>
            {t("Cofnij")}
          </button>
          <button
            className="btn primary"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              void onSave(draft).finally(() => setSaving(false));
            }}
          >
            {t("Zapisz")}
          </button>
        </div>
      )}
    </div>
  );
}
