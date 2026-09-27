import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { scanSource } from "./i18n-scan";

/**
 * Every Polish string the user can see goes through t() / plural(), so the English interface
 * has no Polish left in it. i18n.test.ts checks the dictionary for the keys that do call t();
 * this is the other half: copy that never gets there. The scanner is in i18n-scan.ts.
 */
const ROOT = join(__dirname, "..");
const ROOTS = ["src", "sidecar/src"];

/** Polish on purpose: [file, text it contains, why]. Anything else found is a bug. */
const ALLOWED: [string, string, string][] = [
  ["sidecar/src/cleanup.ts", "Odpowiedz dokładnie jednym słowem", "the e2e test's prompt, matched to spot test sessions"],
  ["sidecar/src/constitution.ts", "", "regex sources matching the user's Polish stop words"],
  ["sidecar/src/elide.ts", "[strażnik", "marker at the start of the guard's own messages to the model"],
  ["sidecar/src/refs.ts", "const refuse", "script run in the browser: cookie-banner button words in many languages"],
  ["sidecar/src/voice.ts", "Własny serwer", "preset table built at load; worded with t(p.label) where it is used"],
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "node_modules" || f === "dist" ? [] : sourceFiles(p);
    return /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

function scanFile(path: string): string[] {
  const rel = relative(ROOT, path).replace(/\\/g, "/");
  return scanSource(readFileSync(path, "utf8"), path.endsWith(".tsx"))
    .filter((h) => !ALLOWED.some(([file, text]) => rel === file && h.text.includes(text)))
    .map((h) => `${rel}:${h.line}: ${h.text.slice(0, 90)}`);
}

describe("every UI string is translatable", () => {
  it("no Polish copy in src/ and sidecar/src/ outside t() / plural()", () => {
    const found = ROOTS.flatMap((r) => sourceFiles(join(ROOT, r))).flatMap(scanFile);
    expect(found).toEqual([]);
  });

  it("every exception still matches something (a stale one would hide a new string)", () => {
    for (const [file, text] of ALLOWED) {
      const hits = scanSource(readFileSync(join(ROOT, file), "utf8"), file.endsWith(".tsx"));
      expect(hits.some((h) => h.text.includes(text)), `${file}: ${text}`).toBe(true);
    }
  });
});

const hits = (src: string, jsx = true) => scanSource(src, jsx).map((h) => h.text);

describe("the scanner", () => {
  it("finds copy in JSX text and attributes at any depth, without diacritics too", () => {
    expect(hits(`export function A() { return <div title="Nowa grupa">{x && <b>Szukaj sesji</b>}</div>; }`)).toEqual(["Nowa grupa", "Szukaj sesji"]);
    expect(hits(`const L = items.map((i) => <li key={i}>Brak sesji w tym projekcie</li>);`)).toEqual(["Brak sesji w tym projekcie"]);
    expect(hits(`const e = <b title={on ? "Ukryj panel" : "Pokaż panel"} />;`)).toEqual(["Ukryj panel", "Pokaż panel"]);
  });

  it("finds single-quoted strings and template chunks", () => {
    expect(hits(`const x = 'Nowa grupa zapisana';`, false)).toEqual(["Nowa grupa zapisana"]);
    expect(hits("const x = `Brak modelu ${m} w projekcie`;", false)).toEqual(["Brak modelu", "w projekcie"]);
  });

  it("skips what t() / plural() already translate", () => {
    expect(hits(`<b title={t("Pokaż")}>{t("Usuń {n}", { n: plural(2, ["plik", "pliki", "plików"], ["file", "files"]) })}</b>`)).toEqual([]);
  });

  it("does not lose its place on parens or braces inside strings", () => {
    expect(hits(`const a = t("krok 1) start"); const b = "Zażółć";`, false)).toEqual(["Zażółć"]);
    expect(hits(`const a = t("a (b"); const b = "Zażółć";`, false)).toEqual(["Zażółć"]);
    expect(hits(`function A() { const s = "{"; } const z = "Zażółć";`, false)).toEqual(["Zażółć"]);
  });

  it("ignores comments, regex literals, generics and technical attributes", () => {
    expect(hits(`function A() { const x = 1; // zmień to\n /** "6 kroków" */ return x; }`, false)).toEqual([]);
    expect(hits(`const R = /u[żz]ytkownik (pyta)/i; const q = a / b;`, false)).toEqual([]);
    expect(hits(`const f = <T,>(x: T) => x; const m = new Map<string, number>(); const X = () => <p>Pokaż</p>;`)).toEqual(["Pokaż"]);
    expect(hits(`const e = <input type="text" className="nowa grupa" data-x="nowa grupa" />;`)).toEqual([]);
    expect(hits(`import { x } from "../lib/no-model"; const c = { cls: "chip model-chip", keywords: "memory pamięć" };`, false)).toEqual([]);
  });
});
