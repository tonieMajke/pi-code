/** Line and word diffs for edit cards: what actually changed, not "all old lines, all new lines". */

export type Seg = { text: string; changed: boolean };
export type DiffLine =
  | { type: "eq"; text: string }
  | { type: "del" | "add"; text: string; segs?: Seg[] }
  /** A run of unchanged lines folded away. */
  | { type: "gap"; count: number };

/** Longest-common-subsequence alignment of two token lists (edit scripts from the model are small). */
function lcs<T>(a: T[], b: T[]): ("eq" | "del" | "add")[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: ("eq" | "del" | "add")[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push("eq");
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push("del");
      i++;
    } else {
      ops.push("add");
      j++;
    }
  }
  while (i++ < n) ops.push("del");
  while (j++ < m) ops.push("add");
  return ops;
}

/** Above this many cells the alignment is skipped (plain replace); keeps huge writes cheap. */
const MAX_CELLS = 4_000_000;

export function splitLines(s: string): string[] {
  const l = s.split("\n");
  if (l.length > 1 && l[l.length - 1] === "") l.pop();
  return l;
}

/** Changed words inside a replaced line: the rest of the line is dimmer. */
function wordDiff(a: string, b: string): [Seg[], Seg[]] | null {
  const tok = (s: string) => s.match(/\w+|\s+|[^\w\s]/g) ?? [];
  const ta = tok(a);
  const tb = tok(b);
  if (ta.length * tb.length > 40_000) return null;
  const ops = lcs(ta, tb);
  const da: Seg[] = [];
  const db: Seg[] = [];
  const push = (arr: Seg[], text: string, changed: boolean) => {
    const last = arr[arr.length - 1];
    if (last && last.changed === changed) last.text += text;
    else arr.push({ text, changed });
  };
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === "eq") {
      push(da, ta[i++], false);
      push(db, tb[j++], false);
    } else if (op === "del") push(da, ta[i++], true);
    else push(db, tb[j++], true);
  }
  // Mostly rewritten: word marks would only add noise.
  const kept = da.filter((s) => !s.changed).reduce((n, s) => n + s.text.trim().length, 0);
  return kept < Math.min(a.trim().length, b.trim().length) * 0.3 ? null : [da, db];
}

/** Old text → new text as diff lines, unchanged runs longer than 2×context folded into a gap. */
export function diffText(oldText: string, newText: string, context = 3): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const raw: DiffLine[] = [];
  if (a.length * b.length > MAX_CELLS) {
    raw.push(...a.map((text) => ({ type: "del" as const, text })), ...b.map((text) => ({ type: "add" as const, text })));
  } else {
    let i = 0;
    let j = 0;
    for (const op of lcs(a, b)) {
      if (op === "eq") {
        raw.push({ type: "eq", text: a[i++] });
        j++;
      } else if (op === "del") raw.push({ type: "del", text: a[i++] });
      else raw.push({ type: "add", text: b[j++] });
    }
  }
  // Pair each run of removed lines with the added run right after it for word marks.
  for (let k = 0; k < raw.length; ) {
    if (raw[k].type !== "del") {
      k++;
      continue;
    }
    let d = k;
    while (d < raw.length && raw[d].type === "del") d++;
    let e = d;
    while (e < raw.length && raw[e].type === "add") e++;
    for (let p = 0; p < Math.min(d - k, e - d); p++) {
      const del = raw[k + p] as Extract<DiffLine, { type: "del" | "add" }>;
      const add = raw[d + p] as Extract<DiffLine, { type: "del" | "add" }>;
      const w = wordDiff(del.text, add.text);
      if (w) [del.segs, add.segs] = w;
    }
    k = e;
  }
  // Fold long unchanged runs.
  const out: DiffLine[] = [];
  for (let k = 0; k < raw.length; ) {
    if (raw[k].type !== "eq") {
      out.push(raw[k++]);
      continue;
    }
    let e = k;
    while (e < raw.length && raw[e].type === "eq") e++;
    const head = k === 0 ? 0 : context;
    const tail = e === raw.length ? 0 : context;
    if (e - k > head + tail + 1) {
      out.push(...raw.slice(k, k + head), { type: "gap", count: e - k - head - tail }, ...raw.slice(e - tail, e));
    } else out.push(...raw.slice(k, e));
    k = e;
  }
  return out;
}

export function countChanges(lines: DiffLine[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.type === "add") add++;
    else if (l.type === "del") del++;
  }
  return { add, del };
}

const cache = new WeakMap<object, DiffLine[]>();

/** Same edit object → same diff (cards re-render on every clock tick while a run works). */
export function diffEdit(edit: { oldText: string; newText: string }): DiffLine[] {
  let d = cache.get(edit);
  if (!d) cache.set(edit, (d = diffText(edit.oldText, edit.newText)));
  return d;
}
