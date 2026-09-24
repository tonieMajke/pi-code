import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * Edit repair: the most common failed call for small models is an edit whose oldText
 * is not in the file. pi already forgives trailing spaces, smart quotes and dashes;
 * what it doesn't forgive is indentation (tabs vs spaces, one level off) — the model
 * got the code right and the whitespace wrong. That case is fixed in place. Every other
 * miss is blocked with the closest region of the file and its line numbers, so the
 * retry works from the real text instead of from memory (and without another read).
 */

type Edit = { oldText: string; newText: string };
export type EditRepair = { fixed: number } | { block: string } | null;

const lf = (s: string) => s.replace(/\r\n?/g, "\n").replace(/^﻿/, "");

/** The same forgiveness pi's edit tool applies (so "found" here means found there). */
function loose(s: string): string {
  return s
    .normalize("NFKC")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, "-");
}

function count(hay: string, needle: string): number {
  return needle ? hay.split(needle).length - 1 : 0;
}

const indentOf = (l: string) => /^[ \t]*/.exec(l)![0];
const core = (l: string) => loose(l).trim();

/** Start lines where oldText matches the file with indentation ignored. */
function indentMatches(fileLines: string[], oldLines: string[]): number[] {
  const want = oldLines.map(core);
  const hits: number[] = [];
  for (let i = 0; i + want.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length && ok; j++) ok = core(fileLines[i + j]) === want[j];
    if (ok) hits.push(i);
  }
  return hits;
}

/**
 * Re-indent newText the way the file indents: each indent the model used for a matched
 * line maps to the file's indent for that line; newText lines use the longest mapping.
 */
function reindent(newText: string, oldLines: string[], fileLines: string[]): string {
  const map = new Map<string, string>();
  oldLines.forEach((l, j) => {
    if (l.trim()) map.set(indentOf(l), indentOf(fileLines[j]));
  });
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  return newText
    .split("\n")
    .map((l) => {
      if (!l.trim()) return l;
      const ind = indentOf(l);
      const key = keys.find((k) => ind.startsWith(k));
      return key === undefined ? l : map.get(key)! + l.slice(key.length);
    })
    .join("\n");
}

/** Character-bigram Dice similarity of two trimmed lines. */
function similar(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) grams.set(a.slice(i, i + 2), (grams.get(a.slice(i, i + 2)) ?? 0) + 1);
  let hit = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      hit++;
      grams.set(g, n - 1);
    }
  }
  return (2 * hit) / (a.length + b.length - 2);
}

/** The window of the file most like oldText: [startLine, score]. */
function closest(fileLines: string[], oldLines: string[]): [number, number] {
  const want = oldLines.map(core);
  const have = fileLines.map(core);
  const n = want.length;
  let best: [number, number] = [0, 0];
  // Anchor on lines that resemble some line of oldText: keeps big files cheap.
  const starts = new Set<number>();
  have.forEach((h, i) => {
    if (!h) return;
    want.forEach((w, j) => {
      if (w && similar(h, w) > 0.6 && i - j >= 0) starts.add(i - j);
    });
  });
  for (const i of starts) {
    let s = 0;
    for (let j = 0; j < n; j++) s += i + j < have.length ? similar(have[i + j], want[j]) : 0;
    const score = s / n;
    if (score > best[1]) best = [i, score];
  }
  return best;
}

function numbered(lines: string[], from: number, to: number): string {
  return lines
    .slice(from, to)
    .map((l, k) => `${String(from + k + 1).padStart(5)}  ${l}`)
    .join("\n");
}

function editsOf(input: Record<string, unknown>): Edit[] | null {
  if (Array.isArray(input.edits)) {
    const e = input.edits as Partial<Edit>[];
    return e.every((x) => typeof x.oldText === "string" && typeof x.newText === "string") ? (e as Edit[]) : null;
  }
  if (typeof input.oldText === "string" && typeof input.newText === "string") return [input as unknown as Edit];
  return null;
}

/**
 * tool_call for edit: fix indentation-only misses in place (mutates input), or explain
 * the miss with the real text. Null: nothing to do (all found, or not ours to judge).
 */
export function repairEdit(input: Record<string, unknown>, cwd: string): EditRepair {
  const edits = editsOf(input);
  const path = typeof input.path === "string" ? input.path : "";
  if (!edits?.length || !path) return null;
  const abs = isAbsolute(path) ? path : resolve(cwd, path.replace(/^@/, ""));
  if (!existsSync(abs)) return null;
  let text: string;
  try {
    text = lf(readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
  const looseText = loose(text);
  const fileLines = text.split("\n");
  let fixed = 0;
  const problems: string[] = [];
  edits.forEach((e, idx) => {
    const old = lf(e.oldText);
    if (!old || count(text, old) === 1 || count(looseText, loose(old)) === 1) return;
    const tag = edits.length > 1 ? `edits[${idx}]` : "oldText";
    const found = count(looseText, loose(old));
    if (found > 1) {
      const firstLine = old.split("\n").find((l) => l.trim()) ?? old;
      const lines = fileLines.flatMap((l, i) => (core(l) === core(firstLine) ? [i + 1] : []));
      problems.push(`${tag} occurs ${found} times (lines ${lines.slice(0, 8).join(", ")}). Add a neighbouring line that makes it unique.`);
      return;
    }
    const oldLines = old.replace(/\n+$/, "").split("\n");
    const hits = indentMatches(fileLines, oldLines);
    if (hits.length === 1) {
      const at = hits[0];
      const real = fileLines.slice(at, at + oldLines.length);
      e.oldText = real.join("\n") + (old.endsWith("\n") ? "\n" : "");
      e.newText = reindent(lf(e.newText), oldLines, real);
      fixed++;
      return;
    }
    if (hits.length > 1) {
      problems.push(`${tag} matches ${hits.length} places once indentation is ignored (lines ${hits.map((h) => h + 1).join(", ")}). Add a neighbouring line that makes it unique.`);
      return;
    }
    const [at, score] = closest(fileLines, oldLines);
    if (score < 0.45) {
      problems.push(`${tag} is not in ${path} and nothing close to it is either. Read the part of the file you want to change, then edit from what is there.`);
      return;
    }
    const from = Math.max(0, at - 1);
    const to = Math.min(fileLines.length, at + oldLines.length + 1);
    problems.push(
      `${tag} is not in ${path}. The closest text is at lines ${at + 1}–${at + oldLines.length} — did you mean this? (current file, with line numbers)\n` +
        `${numbered(fileLines, from, to)}\n` +
        "Copy oldText from these lines exactly (without the line numbers).",
    );
  });
  if (problems.length) return { block: `Edit not applied — nothing was changed.\n${problems.join("\n\n")}` };
  return fixed ? { fixed } : null;
}
