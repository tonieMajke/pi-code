const KEY = "pi-gui-terminal-warn-hidden";

/** „Nie pokazuj więcej” for the first terminal-open warning (localStorage, like AppPrefs). */
export function isTerminalWarnHidden(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function markTerminalWarnHidden(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* in-memory only */
  }
}
