import type { Msg } from "./reducer";

/**
 * Find in the transcript. Searches the reducer state, not the DOM: collapsed tool cards
 * and thinking blocks are not rendered, and they hold most of the text worth finding
 * (bash output). The DOM is only used to highlight what is on screen.
 */
export type FindField = "text" | "thinking" | "tool-args" | "tool-output";

/** One block holding the query `count` times. partIndex is 0 for user/command/info rows. */
export type Match = { msgIndex: number; partIndex: number; field: FindField; count: number };

/** One occurrence — what Enter steps through. */
export type Hit = Match & { occ: number };

export function countIn(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let count = 0;
  for (let i = h.indexOf(n); i !== -1; i = h.indexOf(n, i + n.length)) count++;
  return count;
}

/** Every string inside tool arguments (command, path, edit texts, …), in order. */
function argText(args: unknown): string {
  if (typeof args === "string") return args;
  if (Array.isArray(args)) return args.map(argText).join("\n");
  if (args && typeof args === "object") return Object.values(args).map(argText).join("\n");
  return "";
}

export function findMatches(messages: Msg[], query: string): Match[] {
  const q = query.trim();
  if (!q) return [];
  const out: Match[] = [];
  const add = (msgIndex: number, partIndex: number, field: FindField, text: string) => {
    const count = countIn(text, q);
    if (count) out.push({ msgIndex, partIndex, field, count });
  };
  messages.forEach((m, i) => {
    if (m.role !== "assistant") {
      add(i, 0, "text", m.text);
      return;
    }
    m.parts.forEach((p, j) => {
      if (p.type === "text" || p.type === "notice") add(i, j, "text", p.text);
      else if (p.type === "thinking") add(i, j, "thinking", p.text);
      else {
        add(i, j, "tool-args", argText(p.tool.args));
        add(i, j, "tool-output", p.tool.summary);
      }
    });
  });
  return out;
}

export function hitsOf(matches: Match[]): Hit[] {
  return matches.flatMap((m) => Array.from({ length: m.count }, (_, occ) => ({ ...m, occ })));
}

/** Part of a block's DOM where a field is rendered (the whole block when unknown). */
export const FIELD_SELECTOR: Record<FindField, string | null> = {
  text: null,
  thinking: ".thinking-text",
  "tool-output": ".term-out, .tool-out",
  "tool-args": ".term-cmd, .diff, .tool-args-json, .tool-path, .tool-args",
};

/** DOM ranges of the query inside root's text nodes (case-insensitive). */
export function rangesIn(root: Node, query: string): Range[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: Range[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue ?? "").toLowerCase();
    for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + q.length)) {
      const r = doc.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + q.length);
      out.push(r);
    }
  }
  return out;
}

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
type HighlightCtor = new (...ranges: Range[]) => unknown;

/** CSS Custom Highlight API (::highlight) — no DOM changes, so markdown and shiki stay intact. */
export function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightCtor } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Highlight = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  return css?.highlights && Highlight ? { registry: css.highlights, Highlight } : null;
}

/** Hit's block element: user/command/info rows carry both attributes, assistant parts sit inside the turn. */
export function blockOf(root: ParentNode, hit: Pick<Hit, "msgIndex" | "partIndex">): Element | null {
  const m = hit.msgIndex;
  const p = hit.partIndex;
  return root.querySelector(`[data-msg="${m}"][data-part="${p}"], [data-msg="${m}"] [data-part="${p}"]`);
}

/**
 * Highlight every occurrence on screen and mark the current hit. Without the Highlight API
 * (old WebKit, jsdom) the current block gets an outline instead. Returns what to scroll to.
 */
export function paintFind(root: HTMLElement, query: string, hit: Hit | null): { block: Element | null; current: Range | null } {
  const api = highlightApi();
  root.querySelectorAll(".find-block").forEach((e) => e.classList.remove("find-block"));
  if (!query.trim()) {
    clearFind();
    return { block: null, current: null };
  }
  const block = hit ? blockOf(root, hit) : null;
  let current: Range | null = null;
  if (block && hit) {
    const sel = FIELD_SELECTOR[hit.field];
    const scoped = sel ? [...block.querySelectorAll(sel)] : [];
    const ranges = (scoped.length ? scoped : [block]).flatMap((el) => rangesIn(el, query));
    // The DOM can show a field differently from the state (markdown, shortened paths) — clamp.
    current = ranges.length ? ranges[Math.min(hit.occ, ranges.length - 1)] : null;
  }
  if (api) {
    api.registry.set("find", new api.Highlight(...rangesIn(root, query)));
    if (current) api.registry.set("find-current", new api.Highlight(current));
    else api.registry.delete("find-current");
  }
  if (block && (!api || !current)) block.classList.add("find-block");
  return { block, current };
}

export function clearFind(): void {
  const api = highlightApi();
  api?.registry.delete("find");
  api?.registry.delete("find-current");
}
