import { useState } from "react";
import { ChevronRight, GitCommitHorizontal, Minus, Plus, RefreshCw, Sparkles, Undo2, X } from "lucide-react";
import type { FileChange, GitChanges } from "../../shared/protocol";
import { plural, t } from "../../shared/i18n";

const STATUS_LABEL: Record<string, string> = {
  "??": "nowy",
  A: "dodany",
  M: "zmieniony",
  D: "usunięty",
  R: "przeniesiony",
};

function statusLabel(code: string): string {
  if (code === "??") return STATUS_LABEL["??"];
  const c = code.trim()[0] ?? "M";
  return STATUS_LABEL[c] ?? code.trim();
}

/** Right-hand panel: every uncommitted change in the session's repo, with inline diffs. */
export function ChangesPanel({
  changes,
  loading,
  onRefresh,
  onRevert,
  onClose,
  onStage,
  onUnstage,
  onCommit,
  onSuggest,
}: {
  changes: GitChanges | null;
  loading: boolean;
  onRefresh: () => void;
  onRevert: (path: string) => void;
  onClose: () => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  /** Resolves when committed; rejects with git's message (the draft stays). */
  onCommit: (message: string) => Promise<void>;
  /** The session's model proposes a message for the staged diff. */
  onSuggest: () => Promise<string>;
}) {
  const files = changes?.files ?? [];
  const staged = files.filter((f) => f.index !== "none");
  const unstaged = files.filter((f) => f.index !== "staged");
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState<"commit" | "suggest" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canCommit = staged.length > 0 && message.trim().length > 0 && !working;
  const commit = () => {
    if (!canCommit) return;
    setWorking("commit");
    setError(null);
    onCommit(message).then(
      () => setMessage(""),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    ).finally(() => setWorking(null));
  };
  const suggest = () => {
    setWorking("suggest");
    setError(null);
    onSuggest().then(setMessage, (e: unknown) => setError(e instanceof Error ? e.message : String(e))).finally(() => setWorking(null));
  };
  const add = files.reduce((a, f) => a + f.add, 0);
  const del = files.reduce((a, f) => a + f.del, 0);
  return (
    <aside className="changes">
      <div className="changes-head">
        <span className="changes-title">Zmiany</span>
        {files.length > 0 && (
          <span className="tool-stats">
            <span className="add">+{add}</span>
            <span className="del">−{del}</span>
          </span>
        )}
        <span className="topbar-spacer" />
        <button className="icon-btn" onClick={onRefresh} title="Odśwież">
          <RefreshCw size={14} className={loading ? "spin" : ""} />
        </button>
        <button className="icon-btn" onClick={onClose} title="Zamknij (Ctrl+Shift+D)">
          <X size={15} />
        </button>
      </div>
      <div className="changes-body">
        {!changes && <div className="s-empty">wczytywanie…</div>}
        {changes && !changes.repo && <div className="s-empty">Katalog sesji nie jest repozytorium git.</div>}
        {changes?.repo && files.length === 0 && <div className="s-empty">Brak niezatwierdzonych zmian.</div>}
        {staged.length > 0 && (
          <FileSection
            title={t("Do commitu")}
            files={staged}
            action={{ icon: Minus, label: t("Wyjmij z commitu"), all: t("Wyjmij wszystkie z commitu"), run: onUnstage }}
            onRevert={onRevert}
          />
        )}
        {unstaged.length > 0 && (
          <FileSection
            title={staged.length ? t("Pozostałe zmiany") : t("Zmiany")}
            files={unstaged}
            action={{ icon: Plus, label: t("Dodaj do commitu"), all: t("Dodaj wszystkie do commitu"), run: onStage }}
            onRevert={onRevert}
          />
        )}
      </div>
      {changes?.repo && files.length > 0 && (
        <div className="commit-box">
          <textarea
            value={message}
            placeholder={staged.length ? t("Opis commitu (Ctrl+Enter zatwierdza)") : t("Dodaj pliki przyciskiem +, potem opisz commit")}
            rows={3}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                commit();
              }
            }}
          />
          {error && <div className="commit-error">{error}</div>}
          <div className="commit-actions">
            <button className="btn" onClick={suggest} disabled={!staged.length || working !== null} title={t("Model sesji pisze opis na podstawie dodanych zmian")}>
              <Sparkles size={13} className={working === "suggest" ? "spin" : ""} /> {t("Zaproponuj opis")}
            </button>
            <span className="topbar-spacer" />
            <button className="btn primary" onClick={commit} disabled={!canCommit} title={t("Autor z konfiguracji git projektu")}>
              <GitCommitHorizontal size={14} />
              {working === "commit" ? t("Zatwierdzanie…") : staged.length ? plural(staged.length, ["Commit ({n} plik)", "Commit ({n} pliki)", "Commit ({n} plików)"], ["Commit ({n} file)", "Commit ({n} files)"]) : t("Commit")}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

type SectionAction = { icon: typeof Plus; label: string; all: string; run: (paths: string[]) => void };

function FileSection({ title, files, action, onRevert }: { title: string; files: FileChange[]; action: SectionAction; onRevert: (p: string) => void }) {
  const Icon = action.icon;
  return (
    <section className="chg-section">
      <div className="chg-section-head">
        <span>{title}</span>
        <span className="chg-count">{files.length}</span>
        <span className="topbar-spacer" />
        <button className="icon-btn chg-stage" onClick={() => action.run(files.map((f) => f.path))} title={action.all}>
          <Icon size={13} />
        </button>
      </div>
      {files.map((f) => (
        <ChangedFile key={f.path} file={f} onRevert={onRevert} action={action} />
      ))}
    </section>
  );
}

function ChangedFile({ file, onRevert, action }: { file: FileChange; onRevert: (p: string) => void; action: SectionAction }) {
  const Stage = action.icon;
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const slash = file.path.lastIndexOf("/");
  return (
    <div className={`chg ${open ? "open" : ""}`}>
      <div className="chg-row">
        <button className="chg-main" onClick={() => setOpen((o) => !o)}>
          <ChevronRight size={13} className="tool-chevron" />
          <span className="chg-name">{file.path.slice(slash + 1)}</span>
          <span className="chg-dir">{slash > 0 ? file.path.slice(0, slash) : ""}</span>
        </button>
        <span className={`chg-status s-${file.status.trim()[0] ?? "M"}`}>{statusLabel(file.status)}</span>
        <span className="tool-stats">
          {file.add > 0 && <span className="add">+{file.add}</span>}
          {file.del > 0 && <span className="del">−{file.del}</span>}
        </span>
        <button className="icon-btn chg-stage" onClick={() => action.run([file.path])} title={action.label}>
          <Stage size={13} />
        </button>
        {file.status !== "??" && (
          <button
            className={`icon-btn chg-revert ${confirm ? "confirm" : ""}`}
            title={confirm ? "Kliknij ponownie, aby cofnąć zmiany w pliku" : "Cofnij zmiany w pliku (git restore)"}
            onClick={() => {
              if (confirm) onRevert(file.path);
              setConfirm((c) => !c);
            }}
            onMouseLeave={() => setConfirm(false)}
          >
            <Undo2 size={13} />
            {confirm && <span>Na pewno?</span>}
          </button>
        )}
      </div>
      {open && <Patch patch={file.patch} />}
    </div>
  );
}

function Patch({ patch }: { patch: string }) {
  const lines = patch.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode)/.test(l));
  if (lines.length === 0) return <div className="s-empty">(plik binarny albo brak różnic tekstowych)</div>;
  return (
    <pre className="diff chg-diff">
      {lines.map((l, i) => (
        <div
          key={i}
          className={l.startsWith("@@") ? "diff-hunk" : l.startsWith("+") ? "diff-add" : l.startsWith("-") ? "diff-del" : "diff-ctx"}
        >
          {l.startsWith("@@") ? l : (
            <>
              <span className="diff-sign">{l[0] === "+" ? "+" : l[0] === "-" ? "−" : " "}</span>
              {l.slice(1)}
            </>
          )}
        </div>
      ))}
    </pre>
  );
}
