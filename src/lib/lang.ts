// Imported first by main.tsx: the language must be set before any module builds
// translated constants at load time.
import { setLang, systemLang, type Lang } from "../../shared/i18n";

const KEY = "pi-gui.lang";

/** Saved choice, else the system language (Polish or English). */
export function savedLang(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "pl" || v === "en") return v;
  } catch {
    /* no storage */
  }
  return systemLang(typeof navigator !== "undefined" ? navigator.language : undefined);
}

/** Only stored when the user picks one — until then the app follows the system. */
export function hasSavedLang(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

export function saveLang(l: Lang): void {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* no storage — this run only */
  }
  setLang(l);
}

setLang(savedLang());
document.documentElement.lang = savedLang();
