import { describe, expect, it } from "vitest";
import type { PiEvent } from "../../shared/protocol";
import { PiGateway } from "./gateway";

/** Fake AgentSession: captures the subscriber, lets tests push SDK events. */
function fakeSession() {
  let listener: ((e: unknown) => void) | null = null;
  return {
    state: { isStreaming: false },
    model: { id: "test/model" },
    sessionId: "fake-id",
    dispose() {},
    subscribe(cb: (e: unknown) => void) {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    push(e: unknown) {
      listener?.(e);
    },
  };
}

/** Wire a fake session into the gateway and return [session, events]. */
function wire(): { session: ReturnType<typeof fakeSession>; events: PiEvent[] } {
  const gw = new PiGateway();
  const session = fakeSession();
  const events: PiEvent[] = [];
  const subscribe = (gw as unknown as { subscribe(s: unknown, cb: (e: PiEvent) => void): void }).subscribe;
  subscribe.call(gw, session, (e: PiEvent) => events.push(e));
  return { session, events };
}

describe("PiGateway event normalization", () => {
  it("maps message_update text/thinking deltas", () => {
    const { session, events } = wire();
    session.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hej" } });
    session.push({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } });
    expect(events).toEqual([
      { kind: "text_delta", delta: "hej" },
      { kind: "thinking_delta", delta: "hmm" },
    ]);
  });

  it("maps tool_execution_start/update/end with a summarized result", () => {
    const { session, events } = wire();
    session.push({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "ls" },
    });
    session.push({
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "partial" }] },
    });
    session.push({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "final output" }] },
    });
    expect(events).toEqual([
      { kind: "tool_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
      { kind: "tool_update", toolCallId: "t1", toolName: "bash", partialResult: { content: [{ type: "text", text: "partial" }] } },
      { kind: "tool_end", toolCallId: "t1", toolName: "bash", result: { isError: false, text: "final output" } },
    ]);
  });

  it("truncates long tool results to 400 chars with an ellipsis", () => {
    const { session, events } = wire();
    session.push({
      type: "tool_execution_end",
      toolCallId: "t2",
      toolName: "read",
      isError: false,
      result: { content: [{ type: "text", text: "x".repeat(500) }] },
    });
    const e = events[0];
    if (e.kind !== "tool_end") throw new Error("expected tool_end");
    expect(e.result.text).toBe(`${"x".repeat(400)}…`);
  });

  it("maps turn/agent lifecycle and settled", () => {
    const { session, events } = wire();
    session.push({ type: "turn_start" });
    session.push({ type: "message_end" });
    session.push({ type: "turn_end" });
    session.push({ type: "agent_end" });
    session.push({ type: "agent_settled" });
    expect(events).toEqual([
      { kind: "turn_start" },
      { kind: "message_end" },
      { kind: "turn_end" },
      { kind: "agent_end" },
      { kind: "settled" },
    ]);
  });

  it("ignores unknown event types", () => {
    const { session, events } = wire();
    session.push({ type: "something_new" });
    expect(events).toEqual([]);
  });
});
