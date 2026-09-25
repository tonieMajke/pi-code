/**
 * Microphone levels from the sidecar (~25/s). Kept outside React state: the waveform reads
 * them in its own animation frame, so dictating doesn't re-render the whole app 25 times a second.
 */
type Listener = (level: number, live: boolean) => void;

const listeners = new Set<Listener>();

export function pushVoiceLevel(level: number, live = true): void {
  listeners.forEach((l) => l(level, live));
}

export function onVoiceLevel(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Insert dictated text at the caret: a space where words would otherwise run together. */
export function insertDictation(value: string, start: number, end: number, text: string): { value: string; caret: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^[\s.,!?;:)]/.test(after) ? " " : "";
  const piece = `${lead}${text}${trail}`;
  return { value: before + piece + after, caret: before.length + lead.length + text.length };
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
