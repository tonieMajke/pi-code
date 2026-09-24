import { useEffect, useRef, useState } from "react";
import {
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

const TOOL_VERBS: Record<string, string> = {
  read: "Odczyt",
  write: "Zapis",
  edit: "Edycja",
  bash: "Polecenie",
  glob: "Pliki",
  find: "Pliki",
  ls: "Katalog",
  grep: "Szukanie",
  web_search: "Web",
  fetch_content: "Pobranie",
  source_check: "Źródło",
  look: "Podgląd",
  look_compare: "Porównanie",
  todo: "Plan",
  ui_audit: "Audyt UI",
  design_refs: "Wzorce",
  enable_tools: "Ładuje narzędzia",
  mcp: "MCP",
};

export function toolIcon(name: string) {
  return TOOL_ICONS[name] ?? Wrench;
}

export function toolVerb(name: string): string {
  return TOOL_VERBS[name] ?? name;
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
      (acc, e) => ({ add: acc.add + lines(e.newText).length, del: acc.del + lines(e.oldText).length }),
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
}: {
  tool: ToolItem;
  cwd?: string;
  now?: number;
  /** Parked on the permission gate. */
  awaiting?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(tool.name);
  const target = summarizeArgs(tool.args, cwd);
  const stats = changeStats(tool);
  const running = tool.status === "running";
  const elapsed = tool.start !== undefined ? (tool.end ?? now ?? tool.start) - tool.start : 0;
  // Sub-100 ms calls (reads, writes) would just print "0,0 s" — noise.
  const duration = elapsed >= 100 ? formatDuration(elapsed) : "";

  return (
    <div className={`tool ${awaiting ? "awaiting" : tool.status} ${open ? "open" : ""}`}>
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
        {awaiting && <span className="tool-await">czeka na zgodę</span>}
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
  useEffect(() => {
    if (zoom === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setZoom(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [zoom]);
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

function Lightbox({ img, onClose }: { img: Attachment; onClose: () => void }) {
  const full = useImage(img, true);
  return (
    <div className="lightbox" onClick={onClose}>
      {full && <img src={dataUrl(full)} alt="" />}
    </div>
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
          <pre className="diff" key={i}>
            {lines(e.oldText).map((l, j) => (
              <div className="diff-del" key={`d${j}`}>
                <span className="diff-sign">−</span>
                {l}
              </div>
            ))}
            {lines(e.newText).map((l, j) => (
              <div className="diff-add" key={`a${j}`}>
                <span className="diff-sign">+</span>
                {l}
              </div>
            ))}
          </pre>
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
