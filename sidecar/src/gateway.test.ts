import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    getContextUsage: () => ({ tokens: 1200, contextWindow: 8000, percent: 15 }),
    getSessionStats: () => ({ tokens: { input: 900, output: 300 } }),
    systemPrompt: "x".repeat(400),
    getActiveToolNames: () => ["read"],
    getAllTools: () => [
      { name: "read", description: "d", parameters: {} },
      { name: "off", description: "inactive", parameters: {} },
    ],
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
  const internal = gw as unknown as { session: unknown; subscribe(s: unknown, cb: (e: PiEvent) => void): void };
  internal.session = session; // events from a non-active session are dropped
  internal.subscribe(session, (e: PiEvent) => events.push(e));
  return { session, events };
}

const USAGE = { contextTokens: 1200, contextWindow: 8000, inputTokens: 900, outputTokens: 300,
  // system 400 chars, only the active "read" schema counted
  breakdown: { system: 100, tools: 13, messages: 1087 },
};

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
      { kind: "tool_update", toolCallId: "t1", toolName: "bash", partial: "partial" },
      { kind: "tool_end", toolCallId: "t1", toolName: "bash", result: { isError: false, text: "final output" } },
    ]);
  });

  it("passes images from tool results through to the UI", () => {
    const { session, events } = wire();
    session.push({
      type: "tool_execution_end",
      toolCallId: "t3",
      toolName: "look",
      isError: false,
      result: { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "shot" }] },
    });
    expect(events[0]).toEqual({
      kind: "tool_end",
      toolCallId: "t3",
      toolName: "look",
      result: { isError: false, text: "shot", images: [{ data: "AAAA", mimeType: "image/png" }] },
    });
  });

  it("truncates long tool results to 8000 chars with an ellipsis line", () => {
    const { session, events } = wire();
    session.push({
      type: "tool_execution_end",
      toolCallId: "t2",
      toolName: "read",
      isError: false,
      result: { content: [{ type: "text", text: "x".repeat(9000) }] },
    });
    const e = events[0];
    if (e.kind !== "tool_end") throw new Error("expected tool_end");
    expect(e.result.text).toBe(`${"x".repeat(8000)}\n…`);
  });

  it("maps turn/agent lifecycle and settled, with usage after turn_end and before settled", async () => {
    const { session, events } = wire();
    session.push({ type: "turn_start" });
    session.push({ type: "message_end" });
    session.push({ type: "turn_end" });
    session.push({ type: "agent_end" });
    session.push({ type: "agent_settled" });
    // settled waits for the (here absent) checkpoint diff
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual([
      { kind: "turn_start" },
      { kind: "message_end" },
      { kind: "turn_end" },
      { kind: "usage", usage: USAGE },
      { kind: "agent_end" },
      { kind: "usage", usage: USAGE },
      { kind: "settled" },
    ]);
  });

  it("ignores unknown event types", () => {
    const { session, events } = wire();
    session.push({ type: "something_new" });
    expect(events).toEqual([]);
  });

  it("drops events from a session that is no longer active", () => {
    const gw = new PiGateway();
    const old = fakeSession();
    const events: PiEvent[] = [];
    const internal = gw as unknown as { session: unknown; subscribe(s: unknown, cb: (e: PiEvent) => void): void };
    internal.session = old;
    internal.subscribe(old, (e: PiEvent) => events.push(e));
    internal.session = fakeSession(); // user switched sessions
    old.push({ type: "turn_start" });
    expect(events).toEqual([]);
  });
});

describe("PiGateway.history", () => {
  it("keeps thinking/text/tool order and merges consecutive assistant messages into one turn", () => {
    const gw = new PiGateway();
    const session = fakeSession();
    (session.state as unknown as { messages: unknown[] }).messages = [
      { role: "user", content: "zrób ls" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan" },
          { type: "text", text: "Sprawdzam." },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
        ],
      },
      { role: "toolResult", toolCallId: "c1", isError: false, content: [{ type: "text", text: "a\nb" }] },
      { role: "assistant", content: [{ type: "text", text: "Gotowe." }] },
    ];
    (gw as unknown as { session: unknown }).session = session;
    expect(gw.history()).toEqual([
      { role: "user", text: "zrób ls" },
      {
        role: "assistant",
        parts: [
          { type: "thinking", text: "plan" },
          { type: "text", text: "Sprawdzam." },
          { type: "tool", tool: { id: "c1", name: "bash", args: { command: "ls" }, status: "ok", summary: "a\nb" } },
          { type: "text", text: "Gotowe." },
        ],
      },
    ]);
  });
});

describe("PiGateway slash commands", () => {
  function withSession(extra: Record<string, unknown>) {
    const gw = new PiGateway();
    const session = { ...fakeSession(), ...extra };
    const events: PiEvent[] = [];
    const internal = gw as unknown as { session: unknown; emit: (e: PiEvent) => void; subscribe(s: unknown, cb: (e: PiEvent) => void): void };
    internal.session = session;
    internal.emit = (e) => events.push(e);
    internal.subscribe(session, (e) => events.push(e));
    return { gw, session, events };
  }

  it("an extension command that runs no agent still ends with settled (the UI waits for it)", async () => {
    const { gw, events } = withSession({ prompt: async () => undefined });
    await gw.prompt("/memory");
    expect(events).toEqual([{ kind: "settled" }]);
  });

  it("a real run is not settled twice", async () => {
    const { gw, session, events } = withSession({});
    Object.assign(session, { prompt: async () => session.push({ type: "agent_settled" }) });
    await gw.prompt("zrób coś");
    await new Promise((r) => setTimeout(r, 0));
    expect(events.filter((e) => e.kind === "settled")).toHaveLength(1);
  });

  it("lists extension commands, prompt templates and skills like RPC get_commands", () => {
    const { gw } = withSession({
      extensionRunner: { getRegisteredCommands: () => [{ invocationName: "memory", description: "Pokaż pamięć" }] },
      promptTemplates: [{ name: "fix-tests", description: "Napraw testy" }],
      resourceLoader: { getSkills: () => ({ skills: [{ name: "3d-models", description: "Modele 3D" }] }) },
    });
    expect(gw.commands()).toEqual([
      { name: "memory", description: "Pokaż pamięć", source: "extension" },
      { name: "fix-tests", description: "Napraw testy", source: "prompt" },
      { name: "skill:3d-models", description: "Modele 3D", source: "skill" },
    ]);
  });

  it("fork points come newest first", () => {
    const { gw } = withSession({
      getUserMessagesForForking: () => [
        { entryId: "a", text: "pierwsza" },
        { entryId: "b", text: "druga" },
      ],
    });
    expect(gw.forkPoints().map((p) => p.entryId)).toEqual(["b", "a"]);
  });
});

describe("PiGateway handoff", () => {
  function setup(complete: (ctx: unknown, opts: { signal: AbortSignal }) => Promise<unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "pi-gui-handoff-"));
    const gw = new PiGateway();
    const started: unknown[] = [];
    const internal = gw as unknown as { session: unknown; startSession: (...a: unknown[]) => Promise<void> };
    internal.session = {
      ...fakeSession(),
      sessionName: "Stara sesja",
      sessionFile: undefined,
      sessionManager: {
        getBranch: () => [{ type: "message", id: "1", message: { role: "user", content: "Zrób parser CSV", timestamp: 0 } }],
        isPersisted: () => false,
        getSessionDir: () => dir,
      },
      modelRuntime: { complete: (_m: unknown, ctx: unknown, opts: { signal: AbortSignal }) => complete(ctx, opts) },
    };
    internal.startSession = async (...a: unknown[]) => {
      started.push(a);
    };
    return { gw, started, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("the model writes the prompt from the conversation, then a fresh session starts", async () => {
    let seen = "";
    const { gw, started, cleanup } = setup(async (ctx) => {
      seen = JSON.stringify(ctx);
      return { stopReason: "stop", content: [{ type: "text", text: "## Kontekst\nparser CSV" }] };
    });
    try {
      const res = await gw.handoff(() => {}, "dodaj testy");
      expect(res).toEqual({ prompt: "## Kontekst\nparser CSV", from: "Stara sesja" });
      expect(seen).toContain("Zrób parser CSV");
      expect(seen).toContain("dodaj testy");
      expect(started).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("abort cancels the handoff and keeps the old session", async () => {
    const { gw, started, cleanup } = setup(
      (_ctx, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ stopReason: "aborted", content: [] }))),
    );
    try {
      const run = gw.handoff(() => {}, "");
      await gw.abort();
      await expect(run).rejects.toThrow(/przerwany/);
      expect(started).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
