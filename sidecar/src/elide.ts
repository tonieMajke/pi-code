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

/**
 * Screenshots cost ~1–1.5k tokens each. Within the current run (after the latest user
 * message) only the newest `keep` image-bearing tool results stay as pictures; older
 * ones become a one-line note. Earlier runs are handled by elideOldToolOutput.
 */
export function elideOldImages<M extends Msg>(messages: M[], keep: number): M[] {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  const withImages: number[] = [];
  for (let i = lastUser + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "toolResult" && Array.isArray(m.content) && (m.content as Block[]).some((b) => b.type === "image")) withImages.push(i);
  }
  const drop = new Set(withImages.slice(0, Math.max(0, withImages.length - keep)));
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
