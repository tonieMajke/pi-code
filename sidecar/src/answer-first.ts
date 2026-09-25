/**
 * "Answer first": when the user interrupts (Esc, then a message) or writes while the model
 * works, the next reply must be text. One session: the user asked "co Ty właściwie robisz?"
 * twice; Swift wrote the status into its reasoning (collapsed in the GUI) and carried on with
 * browser calls. The MIDRUN_NOTE asks nicely; this enforces it at the provider request:
 * tool_choice "none" for that one request (llama.cpp keeps the tools in the prompt, so the
 * cached prefix survives), plus a note on the user's message. The run then ends — the user
 * decides whether to go on.
 */
export const ANSWER_NOTE =
  "\n\n[Pi Code: the user interrupted you. Tools are switched off for this one reply. Answer their message in visible text now: " +
  "what you did, what you were about to do and why, and what you need from them. Do not describe tool calls as done that did not run. " +
  "After this reply the run stops; the user will say whether to continue.]";

type Payload = Record<string, unknown> & { messages?: unknown[]; tools?: unknown[] };
type Msg = { role?: string; content?: unknown };

function textOf(m: Msg): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return (m.content as { type?: string; text?: string }[]).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
}

export class AnswerFirst {
  /** Start of the user's message the next reply must answer. */
  private pending: string | null = null;
  private interrupted = false;
  /** This run's reply was forced to text: no guard may send the model back to work. */
  answered = false;

  /** The user stopped the model. */
  interrupt(): void {
    this.interrupted = true;
  }

  /** A user message: mid-run, or the first one after an interruption, must be answered first. */
  userMessage(text: string, midRun: boolean): void {
    this.pending = midRun || this.interrupted ? text.trim().slice(0, 80) : null;
    this.interrupted = false;
  }

  startRun(): void {
    this.answered = false;
  }

  /**
   * before_provider_request: returns the changed payload when this request answers the pending
   * message (the last message is that user message), or undefined.
   */
  apply(payload: unknown): Payload | undefined {
    if (this.pending === null || !payload || typeof payload !== "object") return undefined;
    const p = payload as Payload;
    const messages = p.messages;
    if (!Array.isArray(messages) || !messages.length) return undefined;
    const last = messages[messages.length - 1] as Msg;
    // A guard's nudge (also role "user") may come first; wait for the user's own message.
    if (last.role !== "user" || !textOf(last).includes(this.pending)) return undefined;
    this.pending = null;
    this.answered = true;
    const content =
      typeof last.content === "string"
        ? last.content + ANSWER_NOTE
        : Array.isArray(last.content)
          ? [...last.content, { type: "text", text: ANSWER_NOTE }]
          : last.content;
    const out: Payload = { ...p, messages: [...messages.slice(0, -1), { ...last, content }] };
    if (Array.isArray(p.tools) && p.tools.length) {
      // Anthropic's tools carry input_schema and take an object; OpenAI-style APIs take "none".
      const anthropic = typeof (p.tools[0] as { input_schema?: unknown }).input_schema === "object";
      out.tool_choice = anthropic ? { type: "none" } : "none";
    }
    return out;
  }
}
