/**
 * Context diet for small models: big tool outputs from earlier prompts are
 * replaced by their head plus a note. Only results *before the latest user
 * message* are touched, so the prompt prefix stays stable for the whole run
 * (llama.cpp's prefix cache keeps working) and the current task is never cut.
 * Applied per request via pi's `context` hook — the session file keeps everything.
 */
type Block = { type: string; text?: string };
type Msg = { role: string; content?: unknown };

const HEAD = 400;

export function elideOldToolOutput<M extends Msg>(messages: M[], aboveChars: number): M[] {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUser = i;
      break;
    }
  }
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
