import { useState } from "react";
import { ChevronRight, RefreshCw, Undo2, X } from "lucide-react";
import type { FileChange, GitChanges } from "../../shared/protocol";

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
}: {
  changes: GitChanges | null;
  loading: boolean;
  onRefresh: () => void;
  onRevert: (path: string) => void;
  onClose: () => void;
}) {
  const files = changes?.files ?? [];
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
        {files.map((f) => (
          <ChangedFile key={f.path} file={f} onRevert={onRevert} />
        ))}
      </div>
    </aside>
  );
}

function ChangedFile({ file, onRevert }: { file: FileChange; onRevert: (p: string) => void }) {
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
