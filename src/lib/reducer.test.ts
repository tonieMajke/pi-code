import { describe, expect, it } from "vitest";
import type { PiEvent } from "../../shared/protocol";
import { initialState, reducer, type State } from "./reducer";

const ev = (e: PiEvent) => ({ type: "event", event: e }) as const;

function lastAssistant(state: State) {
  const m = state.messages[state.messages.length - 1];
  if (!m || m.role !== "assistant") throw new Error("no open assistant message");
  return m;
}

describe("reducer", () => {
  it("user action appends a user message and sets busy", () => {
    const s = reducer(initialState, { type: "user", text: "hej" });
    expect(s.busy).toBe(true);
    expect(s.messages.at(-1)).toEqual({ role: "user", text: "hej" });
  });

  it("text_delta accumulates into the open assistant message", () => {
    let s = reducer(initialState, { type: "user", text: "hej" });
    s = reducer(s, ev({ kind: "text_delta", delta: "a" }));
    s = reducer(s, ev({ kind: "text_delta", delta: "b" }));
    expect(lastAssistant(s).text).toBe("ab");
    expect(lastAssistant(s).open).toBe(true);
  });

  it("thinking_delta accumulates into the open assistant thinking", () => {
    let s = initialState;
    s = reducer(s, ev({ kind: "thinking_delta", delta: "x" }));
    s = reducer(s, ev({ kind: "thinking_delta", delta: "y" }));
    expect(lastAssistant(s).thinking).toBe("xy");
  });

  it("tool_start then tool_end moves the tool running -> ok with summary", () => {
    let s = initialState;
    s = reducer(s, ev({ kind: "tool_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } }));
    expect(lastAssistant(s).tools[0]).toMatchObject({ id: "t1", status: "running", summary: "" });
    s = reducer(s, ev({ kind: "tool_end", toolCallId: "t1", toolName: "bash", result: { isError: false, text: "out" } }));
    expect(lastAssistant(s).tools[0]).toMatchObject({ status: "ok", summary: "out" });
  });

  it("tool_end with isError marks the tool as error", () => {
    let s = initialState;
    s = reducer(s, ev({ kind: "tool_start", toolCallId: "t2", toolName: "read", args: {} }));
    s = reducer(s, ev({ kind: "tool_end", toolCallId: "t2", toolName: "read", result: { isError: true, text: "boom" } }));
    expect(lastAssistant(s).tools[0]).toMatchObject({ status: "error", summary: "boom" });
  });

  it("settled closes all assistant messages, unsets busy, bumps settledCount", () => {
    let s = reducer(initialState, { type: "user", text: "hej" });
    s = reducer(s, ev({ kind: "text_delta", delta: "a" }));
    const before = s.settledCount;
    s = reducer(s, ev({ kind: "settled" }));
    expect(s.busy).toBe(false);
    expect(s.settledCount).toBe(before + 1);
    for (const m of s.messages) if (m.role === "assistant") expect(m.open).toBe(false);
  });

  it("history maps transcript items to closed assistant messages with tools", () => {
    const s = reducer(initialState, {
      type: "history",
      items: [
        { role: "user", text: "q" },
        {
          role: "assistant",
          thinking: "th",
          text: "ans",
          tools: [{ id: "x", name: "bash", args: {}, status: "ok", summary: "s" }],
        },
      ],
    });
    expect(s.messages).toHaveLength(2);
    const a = s.messages[1];
    if (a.role !== "assistant") throw new Error("expected assistant");
    expect(a.open).toBe(false);
    expect(a.tools).toHaveLength(1);
    expect(a.text).toBe("ans");
  });

  it("init_done stores model/cwd/sessionId and marks connected", () => {
    const s = reducer(initialState, ev({ kind: "init_done", cwd: "/w", model: "m", sessionId: "sid" }));
    expect(s).toMatchObject({ model: "m", cwd: "/w", sessionId: "sid", connected: true });
  });

  it("clear empties messages and error", () => {
    let s = reducer(initialState, { type: "user", text: "x" });
    s = reducer(s, { type: "error", error: "boom" });
    s = reducer(s, { type: "clear" });
    expect(s.messages).toEqual([]);
    expect(s.error).toBeNull();
  });
});
