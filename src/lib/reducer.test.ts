import { describe, expect, it } from "vitest";
import type { PiEvent } from "../../shared/protocol";
import { initialState, reducer, type Part, type State } from "./reducer";

const ev = (e: PiEvent, at?: number) => ({ type: "event", event: e, at }) as const;

function lastAssistant(state: State) {
  const m = state.messages[state.messages.length - 1];
  if (!m || m.role !== "assistant") throw new Error("no open assistant message");
  return m;
}

const tools = (parts: Part[]) => parts.flatMap((p) => (p.type === "tool" ? [p.tool] : []));

describe("reducer", () => {
  it("user action appends a user message, sets busy and busySince", () => {
    const s = reducer(initialState, { type: "user", text: "hej", at: 100 });
    expect(s.busy).toBe(true);
    expect(s.busySince).toBe(100);
    expect(s.messages.at(-1)).toEqual({ role: "user", text: "hej" });
  });

  it("a mid-run message waits in pending until the SDK consumes it", () => {
    let s = reducer(initialState, { type: "user", text: "a", at: 100 });
    s = reducer(s, ev({ kind: "tool_start", toolCallId: "t1", toolName: "bash", args: {} }, 110));
    s = reducer(s, { type: "user", text: "steer", at: 500 });
    expect(s.busySince).toBe(100);
    expect(s.pending).toEqual([{ text: "steer" }]);
    expect(s.messages.filter((m) => m.role === "user")).toHaveLength(1);
    s = reducer(s, ev({ kind: "queue", steering: 1, followUp: 0 }));
    expect(s.pending).toEqual([{ text: "steer" }]); // still queued
    // tool from the current turn finishes, then SDK takes the steer message
    s = reducer(s, ev({ kind: "tool_end", toolCallId: "t1", toolName: "bash", result: { isError: false, text: "ok" } }, 900));
    s = reducer(s, ev({ kind: "queue", steering: 0, followUp: 0 }, 950));
    expect(s.pending).toEqual([]);
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    s = reducer(s, ev({ kind: "text_delta", delta: "po" }));
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const first = s.messages[1];
    if (first.role !== "assistant") throw new Error("expected assistant");
    expect(tools(first.parts)[0].status).toBe("ok");
  });

  it("tool_end reaches a tool in an earlier (already closed) turn", () => {
    let s: State = {
      ...initialState,
      messages: [
        { role: "assistant", open: false, parts: [{ type: "tool", tool: { id: "t9", name: "bash", args: {}, status: "running", summary: "" } }] },
        { role: "user", text: "x" },
      ],
    };
    s = reducer(s, ev({ kind: "tool_end", toolCallId: "t9", toolName: "bash", result: { isError: false, text: "done" } }));
    const a = s.messages[0];
    if (a.role !== "assistant") throw new Error("expected assistant");
    expect(tools(a.parts)[0]).toMatchObject({ status: "ok", summary: "done" });
    expect(s.messages).toHaveLength(2); // no phantom turn created
  });

  it("text_delta accumulates into one text part of the open assistant turn", () => {
    let s = reducer(initialState, { type: "user", text: "hej" });
    s = reducer(s, ev({ kind: "text_delta", delta: "a" }));
    s = reducer(s, ev({ kind: "text_delta", delta: "b" }));
    expect(lastAssistant(s).parts).toEqual([{ type: "text", text: "ab" }]);
    expect(lastAssistant(s).open).toBe(true);
  });

  it("keeps thinking → text → tool → text in production order", () => {
    let s = initialState;
    s = reducer(s, ev({ kind: "thinking_delta", delta: "x" }, 10));
    s = reducer(s, ev({ kind: "thinking_delta", delta: "y" }, 20));
    s = reducer(s, ev({ kind: "text_delta", delta: "Sprawdzam." }, 40));
    s = reducer(s, ev({ kind: "tool_start", toolCallId: "t1", toolName: "bash", args: {} }, 50));
    s = reducer(s, ev({ kind: "text_delta", delta: "Gotowe." }, 90));
    const parts = lastAssistant(s).parts;
    expect(parts.map((p) => p.type)).toEqual(["thinking", "text", "tool", "text"]);
    expect(parts[0]).toEqual({ type: "thinking", text: "xy", start: 10, end: 40 });
  });

  it("tool_start then tool_end moves the tool running -> ok with summary and timing", () => {
    let s = initialState;
    s = reducer(s, ev({ kind: "tool_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } }, 1000));
    expect(tools(lastAssistant(s).parts)[0]).toMatchObject({ id: "t1", status: "running", summary: "", start: 1000 });
    s = reducer(s, ev({ kind: "tool_update", toolCallId: "t1", toolName: "bash", partial: "par" }));
    expect(tools(lastAssistant(s).parts)[0].summary).toBe("par");
    s = reducer(s, ev({ kind: "tool_end", toolCallId: "t1", toolName: "bash", result: { isError: false, text: "out" } }, 1800));
    expect(tools(lastAssistant(s).parts)[0]).toMatchObject({ status: "ok", summary: "out", end: 1800 });
  });

  it("tool_end with isError marks the tool as error", () => {
    let s = initialState;
    s = reducer(s, ev({ kind: "tool_start", toolCallId: "t2", toolName: "read", args: {} }));
    s = reducer(s, ev({ kind: "tool_end", toolCallId: "t2", toolName: "read", result: { isError: true, text: "boom" } }));
    expect(tools(lastAssistant(s).parts)[0]).toMatchObject({ status: "error", summary: "boom" });
  });

  it("settled closes assistant turns (and running thinking), unsets busy, bumps settledCount", () => {
    let s = reducer(initialState, { type: "user", text: "hej", at: 1 });
    s = reducer(s, ev({ kind: "thinking_delta", delta: "a" }, 5));
    const before = s.settledCount;
    s = reducer(s, ev({ kind: "settled" }, 9));
    expect(s).toMatchObject({ busy: false, busySince: null, pending: [], settledCount: before + 1 });
    expect(lastAssistant(s).open).toBe(false);
    expect(lastAssistant(s).parts[0]).toMatchObject({ type: "thinking", end: 9 });
  });

  it("settled after abort marks cut-off tools as errors and keeps unsent messages visible", () => {
    let s = reducer(initialState, { type: "user", text: "go", at: 1 });
    s = reducer(s, ev({ kind: "tool_start", toolCallId: "t1", toolName: "bash", args: {} }, 2));
    s = reducer(s, { type: "user", text: "later" });
    s = reducer(s, ev({ kind: "settled" }, 9));
    expect(s.pending).toEqual([]);
    expect(s.messages.at(-1)).toEqual({ role: "user", text: "later" });
    const a = s.messages[1];
    if (a.role !== "assistant") throw new Error("expected assistant");
    expect(tools(a.parts)[0]).toMatchObject({ status: "error", summary: "przerwano", end: 9 });
  });

  it("history maps transcript items to closed assistant turns with ordered parts", () => {
    const s = reducer(initialState, {
      type: "history",
      items: [
        { role: "user", text: "q" },
        {
          role: "assistant",
          parts: [
            { type: "thinking", text: "th" },
            { type: "tool", tool: { id: "x", name: "bash", args: {}, status: "ok", summary: "s" } },
            { type: "text", text: "ans" },
          ],
        },
      ],
    });
    expect(s.messages).toHaveLength(2);
    const a = s.messages[1];
    if (a.role !== "assistant") throw new Error("expected assistant");
    expect(a.open).toBe(false);
    expect(a.parts.map((p) => p.type)).toEqual(["thinking", "tool", "text"]);
  });

  it("init_done stores session metadata and marks connected", () => {
    const s = reducer(
      initialState,
      ev({
        kind: "init_done",
        cwd: "/w",
        model: "m",
        provider: "p",
        sessionId: "sid",
        sessionPath: "/s.jsonl",
        sessionName: "n",
        branch: "main",
        mode: "plan",
        user: "ala",
      }),
    );
    expect(s).toMatchObject({ model: "m", provider: "p", cwd: "/w", sessionId: "sid", sessionPath: "/s.jsonl", branch: "main", mode: "plan", user: "ala", connected: true });
  });

  it("usage event stores context usage", () => {
    const usage = { contextTokens: 10, contextWindow: 100, inputTokens: 5, outputTokens: 5 };
    expect(reducer(initialState, ev({ kind: "usage", usage })).usage).toEqual(usage);
  });

  it("approval requests queue up and clear on approval_done / settled", () => {
    let s = reducer(initialState, { type: "user", text: "go", at: 1 });
    s = reducer(s, ev({ kind: "approval_request", toolCallId: "a", toolName: "bash", args: { command: "x" } }));
    s = reducer(s, ev({ kind: "approval_request", toolCallId: "b", toolName: "edit", args: {} }));
    expect(s.approvals.map((a) => a.toolCallId)).toEqual(["a", "b"]);
    s = reducer(s, ev({ kind: "approval_done", toolCallId: "a", decision: "allow" }));
    expect(s.approvals.map((a) => a.toolCallId)).toEqual(["b"]);
    s = reducer(s, ev({ kind: "settled" }));
    expect(s.approvals).toEqual([]);
  });

  it("live perf is replaced per event and done stats attach to the latest assistant turn", () => {
    let s = reducer(initialState, { type: "user", text: "go", at: 1 });
    s = reducer(s, ev({ kind: "perf", perf: { phase: "prompt", processed: 10, total: 100, cache: 0, perSec: 900 } }));
    expect(s.perf).toMatchObject({ phase: "prompt", processed: 10 });
    s = reducer(s, ev({ kind: "text_delta", delta: "a" }));
    s = reducer(s, ev({ kind: "perf", perf: { phase: "gen", tokens: 5, perSec: 50, avgPerSec: 48 } }));
    expect(s.perf).toMatchObject({ phase: "gen", perSec: 50 });
    const done = {
      phase: "done" as const,
      promptTokens: 100,
      cacheTokens: 0,
      promptPerSec: 900,
      promptMs: 111,
      genTokens: 5,
      genPerSec: 50,
      genMs: 100,
    };
    s = reducer(s, ev({ kind: "perf", perf: done }));
    expect(s.perf).toBeNull();
    expect(lastAssistant(s).stats).toEqual([done]);
  });

  it("user images travel with the message and through pending", () => {
    const img = { data: "AAAA", mimeType: "image/png" };
    let s = reducer(initialState, { type: "user", text: "co to?", images: [img], at: 1 });
    expect(s.messages[0]).toEqual({ role: "user", text: "co to?", images: [img] });
    s = reducer(s, { type: "user", text: "i to", images: [img] });
    expect(s.pending).toEqual([{ text: "i to", images: [img] }]);
    s = reducer(s, ev({ kind: "queue", steering: 0, followUp: 0 }));
    expect(s.messages.at(-1)).toEqual({ role: "user", text: "i to", images: [img] });
  });

  it("clear empties messages and error", () => {
    let s = reducer(initialState, { type: "user", text: "x" });
    s = reducer(s, { type: "error", error: "boom" });
    s = reducer(s, { type: "clear" });
    expect(s.messages).toEqual([]);
    expect(s.error).toBeNull();
  });
});

describe("reducer: slash commands and extension dialogs", () => {
  it("an extension command shows its line and keeps the view busy until settled", () => {
    let s = reducer(initialState, { type: "command", text: "/memory", run: true, at: 5 });
    expect(s.messages).toEqual([{ role: "command", text: "/memory" }]);
    expect(s.busy).toBe(true);
    s = reducer(s, { type: "info", text: "pamięć" });
    s = reducer(s, { type: "event", event: { kind: "settled" } });
    expect(s.busy).toBe(false);
    expect(s.messages).toEqual([
      { role: "command", text: "/memory" },
      { role: "info", text: "pamięć", level: "info" },
    ]);
  });

  it("a local command does not touch busy", () => {
    const s = reducer(initialState, { type: "command", text: "/session" });
    expect(s.busy).toBe(false);
  });

  it("dialogs queue up and leave on answer or ui_done", () => {
    let s = reducer(initialState, { type: "event", event: { kind: "ui_request", request: { id: "a", method: "input", title: "x" } } });
    s = reducer(s, { type: "event", event: { kind: "ui_request", request: { id: "b", method: "confirm", title: "y", message: "?" } } });
    expect(s.dialogs.map((d) => d.id)).toEqual(["a", "b"]);
    s = reducer(s, { type: "dialog_done", id: "a" });
    s = reducer(s, { type: "event", event: { kind: "ui_done", id: "b" } });
    expect(s.dialogs).toEqual([]);
  });
});
