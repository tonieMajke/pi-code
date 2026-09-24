import { describe, expect, it } from "vitest";
import { reciteTodo, TodoList } from "./todo.js";

describe("TodoList", () => {
  it("keeps one item in progress and recites only while something is open", () => {
    const t = new TodoList();
    expect(t.set([{ text: "a", status: "in_progress" }, { text: "b", status: "in_progress" }])).toMatch(/Only one/);
    expect(t.set([{ text: "read code", status: "done" }, { text: "fix bug", status: "in_progress" }, { text: "run tests", status: "pending" }])).toBeNull();
    expect(t.recitation()).toMatch(/1\/3 done[\s\S]*\[x\] read code\n\[>\] fix bug\n\[ \] run tests/);
    expect(t.unfinishedNudge()?.content).toMatch(/2 open item/);
    t.set([{ text: "read code", status: "done" }, { text: "fix bug", status: "done" }, { text: "run tests", status: "skipped" }]);
    expect(t.recitation()).toBeNull();
    expect(t.unfinishedNudge()).toBeNull();
  });
});

describe("reciteTodo", () => {
  it("appends the plan to the last tool result or user message, for this request only", () => {
    const msgs = [
      { role: "user", content: "task" },
      { role: "toolResult", content: [{ type: "text", text: "ok" }] },
    ];
    const out = reciteTodo(msgs, "[plan]");
    expect(out[1]).toEqual({ role: "toolResult", content: [{ type: "text", text: "ok" }, { type: "text", text: "\n\n[plan]" }] });
    expect(msgs[1].content).toHaveLength(1);
    expect(reciteTodo([{ role: "assistant", content: [] }], "[plan]")).toEqual([{ role: "assistant", content: [] }]);
    expect(reciteTodo(msgs, null)).toBe(msgs);
  });
});
