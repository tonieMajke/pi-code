import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EN } from "./i18n-en";
import { plural, setLang, t } from "./i18n";

const ROOTS = ["src", "sidecar/src", "shared"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.startsWith("i18n") ? [p] : [];
  });
}

/** Literal first arguments of t("…") / t('…') — keys must be literals so this scan sees them. */
function keysIn(src: string): string[] {
  const out: string[] = [];
  const re = /\bt\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  for (const m of src.matchAll(re)) out.push(JSON.parse(m[1].startsWith("'") ? `"${m[1].slice(1, -1).replace(/"/g, '\\"')}"` : m[1]));
  return out;
}

describe("i18n", () => {
  afterEach(() => setLang("pl"));

  it("every t() key has an English entry", () => {
    const missing = new Set<string>();
    for (const root of ROOTS) for (const f of files(root)) for (const k of keysIn(readFileSync(f, "utf8"))) if (!(k in EN)) missing.add(k);
    expect([...missing]).toEqual([]);
  });

  it("t() keeps no template literal keys", () => {
    const bad: string[] = [];
    for (const root of ROOTS) for (const f of files(root)) if (/\bt\(\s*`/.test(readFileSync(f, "utf8"))) bad.push(f);
    expect(bad).toEqual([]);
  });

  it("English entries keep the same {placeholders}", () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    const off = Object.entries(EN).filter(([pl, en]) => vars(pl) !== vars(en)).map(([pl]) => pl);
    expect(off).toEqual([]);
  });

  it("interpolates and falls back to Polish", () => {
    expect(t("nieznany tekst {x}", { x: 1 })).toBe("nieznany tekst 1");
    setLang("en");
    expect(t("nieznany tekst {x}", { x: 2 })).toBe("nieznany tekst 2");
  });

  it("Polish plural forms", () => {
    const f = (n: number) => plural(n, ["{n} plik", "{n} pliki", "{n} plików"], ["{n} file", "{n} files"]);
    expect([1, 2, 5, 12, 22, 25, 112].map(f)).toEqual(["1 plik", "2 pliki", "5 plików", "12 plików", "22 pliki", "25 plików", "112 plików"]);
    setLang("en");
    expect([1, 2].map(f)).toEqual(["1 file", "2 files"]);
  });
});
