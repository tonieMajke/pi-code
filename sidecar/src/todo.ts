/**
 * The plan a small model keeps losing: a todo list it writes with the `todo` tool,
 * recited at the very end of the context on every call (the "recitation" trick) so it
 * stays in the freshest part of attention however long the task gets — and checked
 * before the model may finish.
 */

export type TodoStatus = "pending" | "in_progress" | "done" | "skipped";
export type TodoItem = { text: string; status: TodoStatus };

export const TODO_DESCRIPTION =
  "Keep a short plan for a multi-step task (3+ steps). Send the WHOLE list every time — it replaces the old one. " +
  "Mark exactly one item in_progress while you work on it, done when it is finished and checked, skipped (with the reason in the text) if it turned out unnecessary. " +
  "The current list is shown to you at the end of the context on every turn.";

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

type Msg = { role?: string; content?: unknown };

/**
 * Put the plan after the newest message without disturbing the cached prefix: it is
 * appended as a text part of the last tool result (or user message) of this request only.
 */
export function reciteTodo<T>(messages: T[], text: string | null): T[] {
  if (!text || !messages.length) return messages;
  const last = messages[messages.length - 1] as Msg;
  if (last.role !== "toolResult" && last.role !== "user") return messages;
  const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : Array.isArray(last.content) ? last.content : [];
  const copy = { ...last, content: [...content, { type: "text", text: `\n\n${text}` }] } as T;
  return [...messages.slice(0, -1), copy];
}
