import { useEffect, useRef, useState } from "react";
import {
  AppWindow,
  Check,
  ChevronRight,
  Columns2,
  ListTodo,
  Eye,
  FilePenLine,
  FilePlus2,
  FileText,
  FolderTree,
  Globe,
  Hand,
  Images,
  PackagePlus,
  Ruler,
  Plug,
  Search,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react";
import type { ToolItem } from "./reducer";
import type { Attachment } from "../../shared/protocol";
import { dataUrl } from "./images";
import { useImage, useSeen } from "./image-store";
import { formatDuration } from "./format";
import { Lightbox } from "../components/Lightbox";
import { countChanges, diffEdit, type DiffLine } from "./diff";
import { plural, t } from "../../shared/i18n";

const TOOL_ICONS: Record<string, typeof Wrench> = {
  read: FileText,
  write: FilePlus2,
  edit: FilePenLine,
  bash: SquareTerminal,
  glob: FolderTree,
  find: FolderTree,
  ls: FolderTree,
  grep: Search,
  web_search: Globe,
  fetch_content: Globe,
  source_check: Globe,
  look: Eye,
  look_compare: Columns2,
  todo: ListTodo,
  ui_audit: Ruler,
  design_refs: Images,
  enable_tools: PackagePlus,
  mcp: Plug,
};

/**
 * One-word names for the tool cards. Each entry is a call, not a string: this map is built when
 * the module loads, and the interface language can change while the app runs.
 */
const TOOL_VERBS: Record<string, () => string> = {
  read: () => t("Odczyt"),
  write: () => t("Zapis"),
  edit: () => t("Edycja"),
  bash: () => t("Polecenie"),
  glob: () => t("Pliki"),
  find: () => t("Pliki"),
  ls: () => t("Katalog"),
  grep: () => t("Szukanie"),
  web_search: () => "Web",
  fetch_content: () => t("Pobranie"),
  source_check: () => t("Źródło"),
  look: () => t("Podgląd"),
  look_compare: () => t("Porównanie"),
  todo: () => "Plan",
  ui_audit: () => t("Audyt UI"),
  design_refs: () => t("Wzorce"),
  enable_tools: () => t("Ładuje narzędzia"),
  mcp: () => "MCP",
};

const BROWSER = "browseros_";

export function toolIcon(name: string) {
  return TOOL_ICONS[name] ?? (name.startsWith(BROWSER) ? AppWindow : Wrench);
}

export function toolVerb(name: string): string {
  return TOOL_VERBS[name]?.() ?? (name.startsWith(BROWSER) ? t("Przeglądarka: {name}", { name: name.slice(BROWSER.length) }) : name);
}

type Edit = { oldText: string; newText: string };

function argsOf(tool: ToolItem): Record<string, unknown> {
  return tool.args && typeof tool.args === "object" ? (tool.args as Record<string, unknown>) : {};
}

function editsOf(tool: ToolItem): Edit[] {
  const e = argsOf(tool).edits;
  if (!Array.isArray(e)) return [];
  return e.filter(
    (x): x is Edit => !!x && typeof x.oldText === "string" && typeof x.newText === "string",
  );
}

/** "+3 −1" line counts for edit/write, shown in the collapsed row. */
export function changeStats(tool: ToolItem): { add: number; del: number } | null {
  if (tool.name === "edit") {
    const edits = editsOf(tool);
    if (edits.length === 0) return null;
    return edits.reduce(
      (acc, e) => {
        const c = countChanges(diffEdit(e));
        return { add: acc.add + c.add, del: acc.del + c.del };
      },
      { add: 0, del: 0 },
    );
  }
  if (tool.name === "write") {
    const c = argsOf(tool).content;
    return typeof c === "string" ? { add: lines(c).length, del: 0 } : null;
  }
  return null;
}

function lines(s: string): string[] {
  const l = s.split("\n");
  if (l.length > 1 && l[l.length - 1] === "") l.pop();
  return l;
}

/** Shorten absolute paths under the session cwd to relative ones. */
export function relPath(p: string, cwd: string): string {
  if (cwd && p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
  const home = /^\/home\/[^/]+/.exec(p)?.[0];
  return home ? `~${p.slice(home.length)}` : p;
}

/** Row label: relative path, or "…/dir/file" when it's still long. */
export function shortPath(p: string, cwd: string): string {
  const r = relPath(p, cwd);
  if (r.length <= 48) return r;
  const segs = r.split("/").filter(Boolean);
  return segs.length > 2 ? `…/${segs.slice(-2).join("/")}` : r;
}

export function summarizeArgs(args: unknown, cwd = ""): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  // todo: the item in progress, else how far along
  if (Array.isArray(a.items)) {
    const items = a.items as { text?: string; status?: string }[];
    const now = items.find((i) => i.status === "in_progress")?.text;
    const done = items.filter((i) => i.status === "done" || i.status === "skipped").length;
    return now ? `${done}/${items.length} · ${now}` : `${done}/${items.length}`;
  }
  // look_compare: reference ↔ work
  if (typeof a.a === "string" && typeof a.b === "string") return `${shortPath(a.a, cwd)} ↔ ${shortPath(a.b, cwd)}`;
  for (const key of ["path", "file", "command", "pattern", "query", "url", "target", "tool"]) {
    const v = a[key];
    if (typeof v === "string") {
      const s = key === "path" || key === "file" || key === "target" ? shortPath(v, cwd) : v.split("\n")[0];
      return s.length > 120 ? `${s.slice(0, 120)}…` : s;
    }
  }
  return "";
}

export function ToolCard({
  tool,
  cwd = "",
  now,
  awaiting = false,
  forceOpen = false,
  part,
}: {
  tool: ToolItem;
  cwd?: string;
  now?: number;
  /** Parked on the permission gate. */
  awaiting?: boolean;
  /** Find in transcript hit inside: shown expanded whatever the user toggled. */
  forceOpen?: boolean;
  /** Index in the turn's parts (data-part, for find). */
  part?: number;
}) {
  const [userOpen, setOpen] = useState(false);
  const open = userOpen || forceOpen;
  const Icon = toolIcon(tool.name);
  const target = summarizeArgs(tool.args, cwd);
  const stats = changeStats(tool);
  const running = tool.status === "running";
  const elapsed = tool.start !== undefined ? (tool.end ?? now ?? tool.start) - tool.start : 0;
  // Sub-100 ms calls (reads, writes) would just print "0,0 s" — noise.
  const duration = elapsed >= 100 ? formatDuration(elapsed) : "";

  return (
    <div className={`tool ${awaiting ? "awaiting" : tool.status} ${open ? "open" : ""}`} data-part={part}>
      <button className="tool-row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="tool-glyph">
          {awaiting ? (
            <Hand size={14} strokeWidth={1.75} />
          ) : running ? (
            <span className="spinner" />
          ) : (
            <Icon size={14} strokeWidth={1.75} />
          )}
        </span>
        <span className="tool-name">{toolVerb(tool.name)}</span>
        {target && <span className="tool-args">{target}</span>}
        {stats && (
          <span className="tool-stats">
            {stats.add > 0 && <span className="add">+{stats.add}</span>}
            {stats.del > 0 && <span className="del">−{stats.del}</span>}
          </span>
        )}
        <span className="tool-spacer" />
        {awaiting && <span className="tool-await">{t("czeka na zgodę")}</span>}
        {!awaiting && duration && <span className="tool-time">{duration}</span>}
        {tool.status === "ok" && <Check size={13} className="tool-status ok" />}
        {tool.status === "error" && <X size={13} className="tool-status error" />}
        <ChevronRight size={14} className="tool-chevron" />
      </button>
      {tool.images && tool.images.length > 0 && <ToolShots images={tool.images} />}
      {open && <ToolPreview tool={tool} cwd={cwd} />}
    </div>
  );
}

/** What the model looked at — always visible, click to enlarge. */
function ToolShots({ images }: { images: Attachment[] }) {
  const [zoom, setZoom] = useState<number | null>(null);
  return (
    <>
      <div className="tool-shots">
        {images.map((img, i) => (
          <ToolShot key={img.ref ?? i} img={img} onZoom={() => setZoom(i)} />
        ))}
      </div>
      {zoom !== null && <Lightbox img={images[zoom]} onClose={() => setZoom(null)} />}
    </>
  );
}

function ToolShot({ img, onZoom }: { img: Attachment; onZoom: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const full = useImage(img, useSeen(ref));
  return (
    <button ref={ref} className="tool-shot" onClick={onZoom} title="Powiększ (to widział model)">
      {full ? <img src={dataUrl(full)} alt="" /> : <span className="tool-shot-wait" />}
    </button>
  );
}

/** A real diff: context lines, −/+ pairs with the changed words marked, long unchanged runs folded. */
function DiffView({ lines: dl }: { lines: DiffLine[] }) {
  return (
    <pre className="diff">
      {dl.map((l, j) => {
        if (l.type === "gap") {
          return (
            <div className="diff-gap" key={j}>
              ⋯ {plural(l.count, ["{n} niezmieniona linia", "{n} niezmienione linie", "{n} niezmienionych linii"], ["{n} unchanged line", "{n} unchanged lines"])}
            </div>
          );
        }
        const cls = l.type === "eq" ? "diff-eq" : l.type === "del" ? "diff-del" : "diff-add";
        const sign = l.type === "eq" ? " " : l.type === "del" ? "−" : "+";
        return (
          <div className={cls} key={j}>
            <span className="diff-sign">{sign}</span>
            {l.type !== "eq" && l.segs ? l.segs.map((sg, k) => (sg.changed ? <mark key={k}>{sg.text}</mark> : <span key={k}>{sg.text}</span>)) : l.text}
          </div>
        );
      })}
    </pre>
  );
}

/** Expanded body of a tool call — also used as the preview on the approval card. */
export function ToolPreview({ tool, cwd, preview = false }: { tool: ToolItem; cwd: string; preview?: boolean }) {
  const a = argsOf(tool);
  // As an approval preview nothing has run yet — show only what would happen.
  const out = preview ? "" : tool.summary || (tool.status === "running" ? "wykonywanie…" : "");

  if (tool.name === "bash") {
    return (
      <div className="tool-body term">
        <div className="term-cmd">
          <span className="term-prompt">$</span>
          {String(a.command ?? "")}
        </div>
        {out && <pre className={`term-out ${tool.status === "error" ? "err" : ""}`}>{out}</pre>}
      </div>
    );
  }

  if (tool.name === "edit") {
    const edits = editsOf(tool);
    return (
      <div className="tool-body">
        <div className="tool-path">{relPath(String(a.path ?? ""), cwd)}</div>
        {edits.map((e, i) => (
          <DiffView key={i} lines={diffEdit(e)} />
        ))}
        {tool.status === "error" && <pre className="tool-out err">{out}</pre>}
      </div>
    );
  }

  if (tool.name === "write" && typeof a.content === "string") {
    return (
      <div className="tool-body">
        <div className="tool-path">{relPath(String(a.path ?? ""), cwd)}</div>
        <pre className="diff">
          {lines(a.content).map((l, j) => (
            <div className="diff-add" key={j}>
              <span className="diff-sign">+</span>
              {l}
            </div>
          ))}
        </pre>
        {tool.status === "error" && <pre className="tool-out err">{out}</pre>}
      </div>
    );
  }

  const known = ["read", "grep", "find", "ls", "glob"].includes(tool.name);
  return (
    <div className="tool-body">
      {!known && Object.keys(a).length > 0 && <pre className="tool-args-json">{JSON.stringify(a, null, 2)}</pre>}
      {out && <pre className={`tool-out ${tool.status === "error" ? "err" : ""}`}>{out}</pre>}
    </div>
  );
}
