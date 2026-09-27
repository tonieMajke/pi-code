import { useMemo, useState } from "react";
import { ChevronRight, FileText, Folder, FolderOpen, RefreshCw, Search, X } from "lucide-react";
import type { GitChanges } from "../../shared/protocol";
import { plural, t } from "../../shared/i18n";
import { buildTree, changedDirs, filterFiles, type TreeDir } from "../lib/file-tree";

/**
 * Right-hand panel: the project's files (git ls-files, or find outside a repo). A click puts
 * "@path" into the message; changed files and the folders above them carry a dot.
 */
export function FilesPanel({
  files,
  changes,
  cwd,
  onRefresh,
  onInsert,
  onClose,
}: {
  files: string[] | null;
  changes: GitChanges | null;
  cwd: string;
  onRefresh: () => void;
  onInsert: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const tree = useMemo(() => buildTree(files ?? []), [files]);
  const status = useMemo(() => new Map((changes?.files ?? []).map((f) => [f.path, f.status])), [changes]);
  const dirty = useMemo(() => changedDirs(status.keys()), [status]);
  const hits = useMemo(() => filterFiles(files ?? [], query), [files, query]);
  const toggle = (path: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });

  const fileRow = (path: string, name: string, depth: number, dir?: string) => {
    const st = status.get(path);
    return (
      <button
        key={path}
        className="ft-row ft-file"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onInsert(path)}
        title={t("Wstaw @{path} do wiadomości", { path })}
      >
        <FileText size={13} className="ft-icon" />
        <span className="ft-name">{name}</span>
        {dir && <span className="ft-dir">{dir}</span>}
        {st && <span className={`ft-mark ${st === "??" ? "new" : "mod"}`} title={st === "??" ? t("nowy") : t("zmieniony")} />}
      </button>
    );
  };

  const dirRows = (d: TreeDir, depth: number): React.ReactNode[] =>
    d.dirs.flatMap((sub) => {
      const isOpen = open.has(sub.path);
      return [
        <button key={`d:${sub.path}`} className={`ft-row ft-dirrow ${isOpen ? "open" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(sub.path)}>
          <ChevronRight size={12} className="ft-chev" />
          {isOpen ? <FolderOpen size={13} className="ft-icon" /> : <Folder size={13} className="ft-icon" />}
          <span className="ft-name">{sub.name}</span>
          {dirty.has(sub.path) && <span className="ft-mark mod" />}
        </button>,
        ...(isOpen ? [...dirRows(sub, depth + 1), ...sub.files.map((f) => fileRow(f.path, f.name, depth + 1))] : []),
      ];
    });

  return (
    <aside className="changes files-panel">
      <div className="changes-head">
        <span className="changes-title">{t("Pliki")}</span>
        <span className="files-count" title={cwd}>
          {files ? plural(files.length, ["{n} plik", "{n} pliki", "{n} plików"], ["{n} file", "{n} files"]) : ""}
        </span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onRefresh} title={t("Odśwież")}>
          <RefreshCw size={14} />
        </button>
        <button className="icon-btn" onClick={onClose} title={t("Zamknij (Ctrl+Shift+E)")}>
          <X size={15} />
        </button>
      </div>
      <label className="ft-search">
        <Search size={13} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("Filtruj pliki…")} spellCheck={false} />
      </label>
      <div className="changes-body ft-body">
        {files === null && <div className="ft-empty">{t("Wczytuję…")}</div>}
        {files !== null && query.trim()
          ? hits.length
            ? hits.map((p) => {
                const cut = p.lastIndexOf("/");
                return fileRow(p, p.slice(cut + 1), 0, cut > 0 ? p.slice(0, cut) : undefined);
              })
            : <div className="ft-empty">{t("Nic nie pasuje.")}</div>
          : [...dirRows(tree, 0), ...tree.files.map((f) => fileRow(f.path, f.name, 0))]}
      </div>
    </aside>
  );
}
