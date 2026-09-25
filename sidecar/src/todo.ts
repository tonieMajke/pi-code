/**
 * The plan a small model keeps losing: a todo list it writes with the `todo` tool,
 * recited near the end of the context (the "recitation" trick, pinned so the cached prefix
 * survives — see PlanRecital) so it stays in fresh attention however long the task gets — and checked
 * before the model may finish.
 */

export type TodoStatus = "pending" | "in_progress" | "done" | "skipped";
export type TodoItem = { text: string; status: TodoStatus };

export const TODO_DESCRIPTION =
  "Keep a short plan for a multi-step task (3+ steps). Send the WHOLE list every time — it replaces the old one. " +
  "Mark exactly one item in_progress while you work on it, done when it is finished and checked, skipped (with the reason in the text) if it turned out unnecessary. " +
  "The current list is shown to you near the end of the context whenever it changes.";

const MARK: Record<TodoStatus, string> = { pending: "[ ]", in_progress: "[>]", done: "[x]", skipped: "[-]" };

export class TodoList {
  private items: TodoItem[] = [];

  set(items: TodoItem[]): string | null {
    const clean = items.map((i) => ({ text: String(i.text ?? "").trim(), status: i.status })).filter((i) => i.text);
    if (!clean.length) {
      this.items = [];
      return null;
    }
    if (clean.filter((i) => i.status === "in_progress").length > 1) return "Only one item may be in_progress at a time — finish or pause the others.";
    this.items = clean;
    return null;
  }

  clear(): void {
    this.items = [];
  }

  get all(): TodoItem[] {
    return this.items;
  }

  get open(): TodoItem[] {
    return this.items.filter((i) => i.status === "pending" || i.status === "in_progress");
  }

  render(): string {
    return this.items.map((i) => `${MARK[i.status]} ${i.text}`).join("\n");
  }

  /** The block recited at the end of the context; null when there is nothing left to do. */
  recitation(): string | null {
    if (!this.open.length) return null;
    const done = this.items.length - this.open.length;
    return `[Your plan — ${done}/${this.items.length} done. Keep it current with the todo tool.]\n${this.render()}`;
  }

  /** agent_before_settle: unfinished items the model is about to walk away from. */
  unfinishedNudge(): { content: string; label: string } | null {
    const open = this.open;
    if (!open.length) return null;
    return {
      label: `Plan: ${open.length} ${open.length === 1 ? "punkt niezrobiony" : "punkty niezrobione"}`,
      content:
        `[Plan check]\nYour todo list still has ${open.length} open item(s):\n${open.map((i) => `${MARK[i.status]} ${i.text}`).join("\n")}\n` +
        "Finish them, or update the list: mark done what is done, skipped (with a reason) what is not needed. Then finish.",
    };
  }
}

type Msg = { role?: string; content?: unknown; toolCallId?: string; timestamp?: number };

/** pi hands the `context` hook a structured clone every call, so messages are matched by key, not identity. */
const keyOf = (m: Msg): string | null => m.toolCallId ?? (m.timestamp !== undefined ? `${m.role}@${m.timestamp}` : null);

/**
 * Put the plan after the newest message without disturbing the cached prefix. A recitation
 * is pinned to the tool result (or user message) that was newest when the plan changed — or
 * when the last copy is `every` messages old — and stays on that message in every later
 * request, so the prompt only ever grows at its end. Nothing is stored in the session.
 *
 * The old way re-attached a fresh copy to the newest message on every call: each request
 * then differed from the previous one just before its end, and hybrid models (Qwen3.5/3.8,
 * no partial KV truncation) fell back to a checkpoint up to 100k tokens earlier — measured
 * 30–60 s of prompt processing per step mid-run.
 */
export class PlanRecital {
  private pins = new Map<string, string>();
  private last: { text: string; at: number } | null = null;

  constructor(private every = 12) {}

  apply<T>(messages: T[], text: string | null): T[] {
    const newest = messages[messages.length - 1] as Msg | undefined;
    const key = newest && (newest.role === "toolResult" || newest.role === "user") ? keyOf(newest) : null;
    const due = !this.last || this.last.text !== text || messages.length - this.last.at >= this.every;
    if (text && key && due && !this.pins.has(key)) {
      this.pins.set(key, text);
      this.last = { text, at: messages.length };
    }
    if (!this.pins.size) return messages;
    let changed = false;
    const out = messages.map((m) => {
      const k = keyOf(m as Msg);
      const pinned = k ? this.pins.get(k) : undefined;
      if (pinned === undefined) return m;
      changed = true;
      const c = (m as Msg).content;
      const content = typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : [];
      return { ...m, content: [...content, { type: "text", text: `\n\n${pinned}` }] } as T;
    });
    return changed ? out : messages;
  }
}
