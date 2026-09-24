/**
 * A message the user sends while the model works reaches it mid-run (steer / follow-up).
 * Small models tend to "answer" it only in their thinking and carry on — the user asked
 * "co tam?" and sees nothing. This note asks for a visible reply first; the GUI hides it.
 */
export const MIDRUN_NOTE =
  "\n\n[pi-gui: the user wrote this while you were working. Reply to it first in visible text (1–3 sentences: what you are doing and what is next, or the answer they asked for), then continue — or stop, if that is what they said.]";

export function withMidrunNote(text: string): string {
  return text + MIDRUN_NOTE;
}

export function stripMidrunNote(text: string): string {
  return text.endsWith(MIDRUN_NOTE) ? text.slice(0, -MIDRUN_NOTE.length) : text;
}
