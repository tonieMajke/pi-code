/** Command templates that open a session in a real pi terminal; {cwd} = project folder, {session} = the session file. */
export const TERMINAL_PRESETS = {
  konsole: "konsole --separate --workdir {cwd} -e pi --session {session}",
  kitty: "kitty --directory {cwd} pi --session {session}",
  alacritty: "alacritty --working-directory {cwd} -e pi --session {session}",
} as const;

export type TerminalChoice = keyof typeof TERMINAL_PRESETS | "custom";

/** Which selector option a stored template corresponds to (absent = the konsole default). */
export function terminalChoiceFor(template?: string): TerminalChoice {
  for (const [id, value] of Object.entries(TERMINAL_PRESETS)) if (value === template) return id as TerminalChoice;
  return template ? "custom" : "konsole";
}

/** Template for the selector's value; an empty custom template = undefined (konsole default). */
export function terminalTemplateFor(choice: TerminalChoice, custom: string): string | undefined {
  return choice === "custom" ? (custom.trim() || undefined) : TERMINAL_PRESETS[choice];
}
