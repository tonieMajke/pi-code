import { plural } from "../../shared/i18n";
import type { Part, ToolItem } from "./reducer";

export type Block =
  | { kind: "part"; part: Exclude<Part, { type: "tool" }>; index: number }
  | { kind: "tools"; tools: { tool: ToolItem; index: number }[] }
  /** A finished run of thinking and tool calls between pieces of text, shown as one row. */
  | { kind: "steps"; blocks: Block[]; indices: number[] };

/** Chains shorter than this stay as they are. */
export const COLLAPSE_FROM = 3;

/** Consecutive tool calls render as one compact group (Claude Code style). */
export function toBlocks(parts: Part[]): Block[] {
  const blocks: Block[] = [];
  parts.forEach((p, index) => {
    if (p.type === "tool") {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "tools") last.tools.push({ tool: p.tool, index });
      else blocks.push({ kind: "tools", tools: [{ tool: p.tool, index }] });
    } else {
      blocks.push({ kind: "part", part: p, index });
    }
  });
  return blocks;
}

/**
 * Long chains of "thinking → command → edit → …" fold into one row once they are done. What must
 * stay in sight breaks a chain: text, guard notices, tool screenshots (the user sees what the
 * model saw) and reasoning that answers the user (`keepOpen`). The chain still growing at the end
 * of an open turn stays expanded.
 */
export function groupSteps(blocks: Block[], open: boolean, keepOpen: (index: number) => boolean): Block[] {
  const out: Block[] = [];
  let run: Block[] = [];
  const steps = (bs: Block[]) => bs.reduce((n, b) => n + (b.kind === "tools" ? b.tools.length : 1), 0);
  const flush = (atEnd: boolean) => {
    if (run.length && steps(run) >= COLLAPSE_FROM && !(atEnd && open)) {
      const indices = run.flatMap((b) => (b.kind === "tools" ? b.tools.map((t) => t.index) : b.kind === "part" ? [b.index] : []));
      out.push({ kind: "steps", blocks: run, indices });
    } else out.push(...run);
    run = [];
  };
  for (const b of blocks) {
    const foldable =
      (b.kind === "part" && b.part.type === "thinking" && !keepOpen(b.index)) ||
      (b.kind === "tools" && b.tools.every((t) => !t.tool.images?.length));
    if (foldable) run.push(b);
    else {
      flush(false);
      out.push(b);
    }
  }
  flush(true);
  return out;
}

type Kind = "bash" | "edit" | "read" | "search" | "thinking" | "other";

const KIND_OF: Record<string, Kind> = {
  bash: "bash",
  edit: "edit",
  write: "edit",
  read: "read",
  grep: "search",
  find: "search",
  glob: "search",
  ls: "search",
};

/**
 * Counted tool kinds in words, in the language the interface has right now — plural() is called
 * here, at render time, not when the module loads.
 */
function kindName(k: Kind, c: number): string {
  switch (k) {
    case "bash":
      return plural(c, ["{n} polecenie", "{n} polecenia", "{n} poleceń"], ["{n} command", "{n} commands"]);
    case "edit":
      return plural(c, ["{n} edycja", "{n} edycje", "{n} edycji"], ["{n} edit", "{n} edits"]);
    case "read":
      return plural(c, ["{n} odczyt", "{n} odczyty", "{n} odczytów"], ["{n} read", "{n} reads"]);
    case "search":
      return plural(c, ["{n} wyszukiwanie", "{n} wyszukiwania", "{n} wyszukiwań"], ["{n} search", "{n} searches"]);
    case "thinking":
      return plural(c, ["{n} przemyślenie", "{n} przemyślenia", "{n} przemyśleń"], ["{n} thought", "{n} thoughts"]);
    default:
      return plural(c, ["{n} inne narzędzie", "{n} inne narzędzia", "{n} innych narzędzi"], ["{n} other tool", "{n} other tools"]);
  }
}

export interface StepsSummary {
  /** "6 kroków: 3 polecenia, 2 przemyślenia, 1 edycja" */
  label: string;
  errors: number;
  /** First start to last end, when the parts carry times (live turns; history has none). */
  ms: number | null;
}

export function summarizeSteps(parts: Part[], indices: number[]): StepsSummary {
  const counts = new Map<Kind, number>();
  let errors = 0;
  let start = Infinity;
  let end = -Infinity;
  for (const i of indices) {
    const p = parts[i];
    if (!p || p.type === "text" || p.type === "notice") continue;
    const kind: Kind = p.type === "thinking" ? "thinking" : (KIND_OF[p.tool.name] ?? "other");
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (p.type === "tool" && p.tool.status === "error") errors++;
    const s = p.type === "tool" ? p.tool.start : p.start;
    const e = p.type === "tool" ? p.tool.end : p.end;
    if (s !== undefined) start = Math.min(start, s);
    if (e !== undefined) end = Math.max(end, e);
  }
  const n = [...counts.values()].reduce((a, b) => a + b, 0);
  const detail = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, c]) => kindName(k, c))
    .join(", ");
  return {
    label: `${plural(n, ["{n} krok", "{n} kroki", "{n} kroków"], ["{n} step", "{n} steps"])}: ${detail}`,
    errors,
    ms: Number.isFinite(start) && end > start ? end - start : null,
  };
}
