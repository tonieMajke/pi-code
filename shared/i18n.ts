// UI language. Source strings are Polish and double as keys; English lives in i18n-en.ts.
// A string missing from the dictionary shows in Polish rather than breaking — i18n.test.ts
// keeps the dictionary complete for every literal t("…") in the code.
import { EN } from "./i18n-en.js";

export type Lang = "pl" | "en";

export const LANGS: { id: Lang; label: string }[] = [
  { id: "pl", label: "Polski" },
  { id: "en", label: "English" },
];

let current: Lang = "pl";

export function lang(): Lang {
  return current;
}

export function setLang(l: Lang): void {
  current = l;
}

/** Polish if the system says so, English for everyone else. */
export function systemLang(locale: string | undefined): Lang {
  return locale?.toLowerCase().startsWith("pl") ? "pl" : "en";
}

/** "Usunąć {name}?" + {name: "x"} → "Usunąć x?" (or its English entry). */
export function t(pl: string, vars?: Record<string, string | number>): string {
  const s = current === "en" ? (EN[pl] ?? pl) : pl;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/**
 * Count with the right word form. pl: [1, 2–4, 5+] ("plik", "pliki", "plików");
 * en: [1, other]. `{n}` in a form is replaced by the number.
 */
export function plural(n: number, pl: [string, string, string], en: [string, string]): string {
  let form: string;
  if (current === "en") form = n === 1 ? en[0] : en[1];
  else {
    const d = n % 10;
    const dd = n % 100;
    form = n === 1 ? pl[0] : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? pl[1] : pl[2];
  }
  return form.replace("{n}", String(n));
}

/** Locale tag for Intl / toLocaleString. */
export function locale(): string {
  return current === "en" ? "en-GB" : "pl-PL";
}
