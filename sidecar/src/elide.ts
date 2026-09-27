/**
 * Context diet for small models: big tool outputs from earlier prompts are
 * replaced by their head plus a note. Only results *before the user message that
 * started the current run* are touched, so the prompt prefix stays stable for the whole run
 * (llama.cpp's prefix cache keeps working) and the current task is never cut.
 * Applied per request via pi's `context` hook — the session file keeps everything.
 */
import { MIDRUN_NOTE } from "../../shared/midrun.js";

type Block = { type: string; text?: string };
type Msg = { role: string; content?: unknown };

function userText(m: Msg): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return (m.content as Block[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
}

/**
 * Index of the user message that started the current run (-1: none). Messages the user types
 * mid-run (they carry MIDRUN_NOTE) and the guardian's "[strażnik]" steers are role "user" too,
 * but moving the boundary on them would shorten outputs in the middle of a run and throw away
 * the cached prefix every time one arrives. Same for pi-lens: its findings ("[pi-lens automated
 * …") are appended as role "user" to a single request only, so the boundary jumped there and
 * back — two cache misses of 25–80k tokens each and older outputs cut mid-task.
 */
export function runStart(messages: Msg[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const text = userText(messages[i]);
    if (text.endsWith(MIDRUN_NOTE) || text.startsWith("[strażnik") || text.startsWith("[pi-lens automated")) continue;
    return i;
  }
  return -1;
}

const HEAD = 400;

export function elideOldToolOutput<M extends Msg>(messages: M[], aboveChars: number): M[] {
  const lastUser = runStart(messages);
  if (lastUser <= 0) return messages;
  let changed = false;
  const out = messages.map((m, i) => {
    if (i >= lastUser || m.role !== "toolResult" || !Array.isArray(m.content)) return m;
    const blocks = m.content as Block[];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    const images = blocks.filter((b) => b.type === "image").length;
    if (text.length <= aboveChars && images === 0) return m;
    changed = true;
    const note =
      `${text.slice(0, HEAD)}${text.length > HEAD ? "…" : ""}\n` +
      `[pi-gui: older tool output shortened (${text.length} chars${images ? `, ${images} image(s)` : ""}). ` +
      "Re-run the tool if you need it again.]";
    return { ...m, content: [{ type: "text", text: note }] };
  });
  return changed ? out : messages;
}

/**
 * Screenshots cost ~1–1.5k tokens each. Within the current run the older image-bearing tool
 * results become a one-line note, `batch` at a time: from `keep + batch` screenshots on, the
 * oldest `batch` go at once, so the cached prefix breaks once per `batch` screenshots instead
 * of on every new one (each break = the whole run re-read). Earlier runs: elideOldToolOutput.
 */
export function elideOldImages<M extends Msg>(messages: M[], keep: number, batch = 6): M[] {
  const lastUser = runStart(messages);
  const withImages: number[] = [];
  for (let i = lastUser + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "toolResult" && Array.isArray(m.content) && (m.content as Block[]).some((b) => b.type === "image")) withImages.push(i);
  }
  const over = withImages.length - keep;
  const drop = new Set(withImages.slice(0, over > 0 ? Math.floor(over / batch) * batch : 0));
  if (!drop.size) return messages;
  return messages.map((m, i) => {
    if (!drop.has(i)) return m;
    const blocks = m.content as Block[];
    const n = blocks.filter((b) => b.type === "image").length;
    return {
      ...m,
      content: [
        ...blocks.filter((b) => b.type !== "image"),
        { type: "text", text: `[pi-gui: ${n} older screenshot(s) from this run removed to save context — look again if you need them.]` },
      ],
    };
  });
}
