import type { SlashCommandInfo } from "../../shared/protocol";

/** gui = done by Pi Code itself; terminal = only pi's TUI has it; the rest pi runs from a prompt. */
export type SlashKind = "gui" | "terminal" | SlashCommandInfo["source"];

/** Second step after the name: a list to choose from instead of typing the argument. */
export type SlashPick = "model" | "thinking" | "mode" | "fork";

export type SlashEntry = {
  name: string;
  description: string;
  kind: SlashKind;
  /** Argument hint shown after the name; set = typing continues after the name. */
  args?: string;
  pick?: SlashPick;
};

export const BUILTINS: SlashEntry[] = [
  { name: "compact", description: "Streść rozmowę, żeby zwolnić kontekst", kind: "gui", args: "[instrukcje]" },
  { name: "new", description: "Nowa sesja w tym projekcie", kind: "gui" },
  { name: "model", description: "Zmień model tej sesji", kind: "gui", args: "[model]", pick: "model" },
  { name: "thinking", description: "Poziom myślenia modelu", kind: "gui", args: "[poziom]", pick: "thinking" },
  { name: "mode", description: "Tryb uprawnień", kind: "gui", args: "[tryb]", pick: "mode" },
  { name: "fork", description: "Nowa sesja od wybranej wiadomości (wiadomość wraca do edycji)", kind: "gui", pick: "fork" },
  { name: "clone", description: "Kopia tej sesji jako nowa sesja", kind: "gui" },
  { name: "name", description: "Zmień nazwę sesji", kind: "gui", args: "<nazwa>" },
  { name: "session", description: "Statystyki sesji: wiadomości, narzędzia, tokeny", kind: "gui" },
  { name: "export", description: "Zapisz sesję jako HTML w folderze projektu", kind: "gui" },
  { name: "copy", description: "Skopiuj ostatnią odpowiedź modelu", kind: "gui" },
  { name: "reload", description: "Przeładuj rozszerzenia, skille, szablony i pliki kontekstu", kind: "gui" },
  { name: "settings", description: "Ustawienia", kind: "gui" },
];

/** pi TUI commands without a GUI counterpart yet. */
export const TERMINAL_ONLY: SlashEntry[] = [
  { name: "tree", description: "Drzewo sesji", kind: "terminal" },
  { name: "login", description: "Logowanie do dostawcy modeli", kind: "terminal" },
  { name: "logout", description: "Wylogowanie z dostawcy", kind: "terminal" },
  { name: "llama", description: "Zarządzanie modelami w routerze llama.cpp", kind: "terminal" },
  { name: "scoped-models", description: "Modele do przełączania w TUI", kind: "terminal" },
  { name: "share", description: "Udostępnij sesję linkiem", kind: "terminal" },
  { name: "import", description: "Importuj sesję z pliku JSONL", kind: "terminal" },
];

/** Built-ins first, then what pi offers (extensions, templates, skills), terminal-only last. */
export function allCommands(pi: SlashCommandInfo[]): SlashEntry[] {
  const taken = new Set([...BUILTINS, ...TERMINAL_ONLY].map((c) => c.name));
  const fromPi = pi
    .filter((c) => !taken.has(c.name))
    .map((c): SlashEntry => ({ name: c.name, description: c.description, kind: c.source, args: c.source === "extension" ? undefined : "[tekst]" }));
  return [...BUILTINS, ...fromPi, ...TERMINAL_ONLY];
}

/** "/name args" filling the whole input. Paths such as "/home/x" are not commands. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const m = /^\/([A-Za-z][\w.:-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1], args: (m[2] ?? "").trim() } : null;
}

/** What the popup shows for the text before the caret. */
export type SlashState =
  | { kind: "list"; query: string }
  | { kind: "pick"; entry: SlashEntry; query: string }
  | null;

export function slashState(before: string, commands: SlashEntry[]): SlashState {
  const list = /^\/([\w.:-]*)$/.exec(before);
  if (list) return { kind: "list", query: list[1] };
  const pick = /^\/([\w.:-]+) ([^\n]*)$/.exec(before);
  if (pick) {
    const entry = commands.find((c) => c.name === pick[1]);
    if (entry?.pick) return { kind: "pick", entry, query: pick[2] };
  }
  return null;
}

/** Name prefix beats name substring beats description; ties keep the list order. */
export function matchCommands(commands: SlashEntry[], query: string): SlashEntry[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  const scored: [number, number, SlashEntry][] = [];
  commands.forEach((c, i) => {
    const name = c.name.toLowerCase();
    const score = name.startsWith(q) ? 3 : name.includes(q) ? 2 : c.description.toLowerCase().includes(q) ? 1 : 0;
    if (score) scored.push([score, i, c]);
  });
  return scored.sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(([, , c]) => c);
}

export type PickItem = { key: string; label: string; hint?: string; active?: boolean };

export function matchPicks(items: PickItem[], query: string): PickItem[] {
  const q = query.trim().toLowerCase();
  return q ? items.filter((i) => i.label.toLowerCase().includes(q) || i.key.toLowerCase().includes(q)) : items;
}
