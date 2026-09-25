import { describe, expect, it } from "vitest";
import { PlanRecital, TodoList } from "./todo.js";

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

describe("PlanRecital", () => {
  const user = { role: "user", content: "task", timestamp: 1 };
  const tool = (id: string) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: id }] });
  const asst = (t: number) => ({ role: "assistant", content: [], timestamp: t });
  const texts = (m: { content?: unknown }) => (m.content as { text: string }[]).map((b) => b.text);

  it("pins the plan where it changed and keeps it there, so each request only grows at the end", () => {
    const r = new PlanRecital();
    const first = r.apply([user, asst(2), tool("a")], "[plan v1]");
    expect(texts(first[2])).toEqual(["a", "\n\n[plan v1]"]);
    const second = r.apply([user, asst(2), tool("a"), asst(3), tool("b")], "[plan v1]");
    expect(second.slice(0, 3)).toEqual(first); // same prefix
    expect(texts(second[4])).toEqual(["b"]); // unchanged plan is not repeated
    const third = r.apply([user, asst(2), tool("a"), asst(3), tool("b"), asst(4), tool("c")], "[plan v2]");
    expect(third.slice(0, 5)).toEqual(second);
    expect(texts(third[6])).toEqual(["c", "\n\n[plan v2]"]);
  });

  it("repeats an unchanged plan once it is far behind, and never pins to assistant messages", () => {
    const r = new PlanRecital(4);
    r.apply([user, tool("a")], "[p]");
    const msgs = [user, tool("a"), asst(2), tool("b"), asst(3), tool("c")];
    expect(texts(r.apply(msgs, "[p]")[5])).toEqual(["c", "\n\n[p]"]);
    expect(new PlanRecital().apply([user, asst(2)], "[p]")).toEqual([user, asst(2)]);
    expect(new PlanRecital().apply([user, tool("a")], null)).toEqual([user, tool("a")]);
  });
});
