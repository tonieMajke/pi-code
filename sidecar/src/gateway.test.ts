import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PiEvent } from "../../shared/protocol";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiGateway } from "./gateway";
import { SessionHost, type HostEnv } from "./session-host";

/** Fake AgentSession: captures the subscriber, lets tests push SDK events. */
function fakeSession() {
  let listener: ((e: unknown) => void) | null = null;
  return {
    state: { isStreaming: false, messages: [] as unknown[] },
    model: { id: "test/model" } as Record<string, unknown>,
    sessionId: "fake-id",
    sessionFile: undefined as string | undefined,
    sessionName: "",
    dispose() {},
    abort: async () => undefined,
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

type Internal = {
  env: HostEnv;
  hosts: Map<string, SessionHost>;
  active: SessionHost | null;
  out: (e: PiEvent, session?: string) => void;
  services: unknown;
  config: unknown;
  terminal: unknown;
  startSession: (...a: unknown[]) => Promise<void>;
  newSession: (...a: unknown[]) => Promise<void>;
};

/** Gateway with its output captured; session_status (sidebar markers) kept apart from the transcript events. */
function gateway(limit = 2) {
  const gw = new PiGateway();
  const internal = gw as unknown as Internal;
  const events: PiEvent[] = [];
  const statuses: { session?: string; status: string }[] = [];
  const all: { e: PiEvent; session?: string }[] = [];
  internal.out = (e, session) => {
    all.push({ e, session });
    if (e.kind === "session_status") statuses.push({ session, status: e.status });
    else events.push(e);
  };
  internal.config = { get: () => ({ background: { localLimit: limit }, memory: { enabled: false, learn: false } }) };
  /** A fake session as a live host; the first one added (or `active`) is on screen. */
  const add = (session: ReturnType<typeof fakeSession> & Record<string, unknown>, active = !internal.active) => {
    const host = SessionHost.adopt(internal.env, "/w", session as never);
    internal.hosts.set(host.id, host);
    if (active) internal.active = host;
    return host;
  };
  return { gw, internal, events, statuses, all, add };
}

/** Wire a fake session into the gateway as the session on screen. */
function wire(): { session: ReturnType<typeof fakeSession>; events: PiEvent[] } {
  const { events, add } = gateway();
  const session = fakeSession();
  add(session);
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

  it("a background session's transcript events stay in the sidecar; its status goes out", () => {
    const { internal, all, add } = gateway();
    const old = { ...fakeSession(), sessionId: "old" };
    const oldHost = add(old);
    add({ ...fakeSession(), sessionId: "new" }, true); // user switched sessions
    old.push({ type: "turn_start" });
    old.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
    oldHost.setStatus("approval");
    expect(all).toEqual([{ e: { kind: "session_status", session: "old", path: "", cwd: "/w", title: "", status: "approval" }, session: "old" }]);
    // on screen: everything, tagged with the session
    internal.active = oldHost;
    old.push({ type: "turn_start" });
    expect(all[1]).toEqual({ e: { kind: "turn_start" }, session: "old" });
  });
});

describe("PiGateway.history", () => {
  it("keeps thinking/text/tool order and merges consecutive assistant messages into one turn", () => {
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
      { role: "assistant", content: [{ type: "text", text: "Gotowe." }], timestamp: 42 },
    ];
    const stats = { phase: "done", promptTokens: 900, cacheTokens: 100, promptPerSec: 1800, promptMs: 500, genTokens: 50, genPerSec: 100, genMs: 500 };
    // The run's timings, saved at settle and keyed by its last assistant message.
    (session as unknown as { sessionManager: unknown }).sessionManager = {
      getEntries: () => [
        { type: "custom", customType: "other", data: {} },
        { type: "custom", customType: "pi-gui-stats", data: { after: 42, stats: [stats] } },
      ],
    };
    const g = gateway();
    g.add(session);
    expect(g.gw.history()).toEqual([
      { role: "user", text: "zrób ls" },
      {
        role: "assistant",
        parts: [
          { type: "thinking", text: "plan" },
          { type: "text", text: "Sprawdzam." },
          { type: "tool", tool: { id: "c1", name: "bash", args: { command: "ls" }, status: "ok", summary: "a\nb" } },
          { type: "text", text: "Gotowe." },
        ],
        stats: [stats],
      },
    ]);
  });
});

describe("PiGateway slash commands", () => {
  function withSession(extra: Record<string, unknown>) {
    const { gw, events, add } = gateway();
    const session = { ...fakeSession(), ...extra };
    add(session);
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
    const { gw, internal, add } = gateway();
    const started: unknown[] = [];
    add({
      ...fakeSession(),
      sessionName: "Stara sesja",
      sessionFile: undefined,
      sessionManager: {
        getBranch: () => [{ type: "message", id: "1", message: { role: "user", content: "Zrób parser CSV", timestamp: 0 } }],
        isPersisted: () => false,
        getSessionDir: () => dir,
      },
      modelRuntime: { complete: (_m: unknown, ctx: unknown, opts: { signal: AbortSignal }) => complete(ctx, opts) },
    });
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
      const res = await gw.handoff("dodaj testy");
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
      const run = gw.handoff("");
      await gw.abort();
      await expect(run).rejects.toThrow(/przerwany/);
      expect(started).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe("PiGateway opening a session", () => {
  const PNG = "iVBORw0KGgo=";
  function sessionFile(dir: string): string {
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage({ role: "user", content: "zrób zrzut", timestamp: 0 } as never);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "look", arguments: {} }],
      timestamp: 0,
    } as never);
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "look",
      content: [{ type: "text", text: "zrzut" }, { type: "image", data: PNG, mimeType: "image/png" }],
      isError: false,
      timestamp: 0,
    } as never);
    return sm.getSessionFile()!;
  }

  it("sends the transcript from the file before the session starts, with images as references", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-gui-open-"));
    try {
      const file = sessionFile(dir);
      const { gw, internal, events } = gateway();
      internal.services = {};
      let startedAfter = -1;
      internal.startSession = async () => {
        startedAfter = events.length;
      };
      await gw.openSession(file);
      expect(startedAfter).toBe(1);
      const h = events[0];
      if (h.kind !== "history") throw new Error("expected history first");
      expect(h.sessionPath).toBe(file);
      const tool = h.items[1].role === "assistant" ? h.items[1].parts[0] : null;
      if (tool?.type !== "tool") throw new Error("expected a tool part");
      const [img] = tool.tool.images!;
      expect(img.data).toBe("");
      expect(JSON.stringify(h).includes(PNG)).toBe(false);
      // The image is served from what is on screen, even before the session is up.
      expect(gw.historyImage(img.ref!)).toEqual({ data: PNG, mimeType: "image/png", ref: img.ref });
      expect(() => gw.historyImage(`inna/call-1/0`)).toThrow(/innej sesji/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PiGateway deleting a session", () => {
  function setup() {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-gui-del-"));
    const dir = join(agentDir, "sessions", "--proj--");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "s.jsonl");
    writeFileSync(file, "{}\n");
    process.env.PI_GUI_SIDEBAR = join(agentDir, "sidebar.json");
    const { gw, internal, add } = gateway();
    internal.services = { agentDir };
    gw.trashFile = async (f) => rmSync(f);
    let fresh = 0;
    internal.newSession = async () => {
      fresh++;
    };
    return { gw, internal, add, agentDir, file, fresh: () => fresh, cleanup: () => rmSync(agentDir, { recursive: true, force: true }) };
  }

  it("refuses anything that is not a pi session file", async () => {
    const { gw, agentDir, cleanup } = setup();
    try {
      await expect(gw.deleteSession(join(agentDir, "settings.json"))).rejects.toThrow(/nie jest plik sesji/);
      await expect(gw.deleteSession(join(agentDir, "sessions", "..", "x.jsonl"))).rejects.toThrow(/nie jest plik sesji/);
    } finally {
      cleanup();
      delete process.env.PI_GUI_SIDEBAR;
    }
  });

  it("moves the file to the trash, leaves groups, and replaces the open session", async () => {
    const { gw, internal, add, file, fresh, cleanup } = setup();
    try {
      gw.sidebar.set({ groups: [{ id: "g", name: "G", sessions: [file] }], projects: [] });
      const host = add({ ...fakeSession(), sessionFile: file });
      expect(await gw.deleteSession(file)).toEqual({ path: file, active: true });
      expect(internal.hosts.has(host.id)).toBe(false); // released, not kept as an idle session
      expect(existsSync(file)).toBe(false);
      expect(gw.sidebar.get().groups[0].sessions).toEqual([]);
      expect(fresh()).toBe(1);
    } finally {
      cleanup();
      delete process.env.PI_GUI_SIDEBAR;
    }
  });
});


describe("PiGateway background sessions", () => {
  const LOCAL = { id: "swift", provider: "llama", baseUrl: "http://127.0.0.1:8080/v1" };
  const API = { id: "claude", provider: "anthropic", baseUrl: "https://api.anthropic.com" };
  /** A session in the middle of a run (isStreaming) on the given model. */
  const working = (id: string, model: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const s = { ...fakeSession(), sessionId: id, model, ...extra };
    s.state.isStreaming = true;
    let aborted = false;
    Object.assign(s, {
      abort: async () => {
        aborted = true;
        s.state.isStreaming = false;
      },
    });
    return Object.assign(s, { wasAborted: () => aborted });
  };

  it("an API-model run always goes to the background", async () => {
    const { gw, add } = gateway(0);
    add(working("a", API));
    expect(await gw.prepareSwitch()).toBeNull();
  });

  it("local runs: up to the limit in the background, then the user picks one to stop", async () => {
    const { gw, add } = gateway(2);
    add(working("cur", LOCAL, { sessionName: "Na ekranie" }));
    add(working("bg1", LOCAL, { sessionName: "Pierwsza" }), false);
    expect(await gw.prepareSwitch()).toBeNull(); // 1 of 2 in the background
    add(working("bg2", LOCAL, { sessionName: "Druga" }), false);
    add(working("api", API), false); // API runs don't count
    expect(await gw.prepareSwitch()).toEqual({
      limit: 2,
      running: [
        { session: "cur", title: "Na ekranie", active: true },
        { session: "bg1", title: "Pierwsza", active: false },
        { session: "bg2", title: "Druga", active: false },
      ],
    });
  });

  it("the chosen one is stopped and released; limit 0 stops the one being left, like before", async () => {
    const { gw, internal, add, events } = gateway(1);
    const cur = working("cur", LOCAL);
    const bg = working("bg", LOCAL);
    add(cur);
    add(bg, false);
    expect(await gw.prepareSwitch("bg")).toBeNull();
    expect(bg.wasAborted()).toBe(true);
    expect(internal.hosts.has("bg")).toBe(false);
    expect(events).toContainEqual({ kind: "session_closed", session: "bg", path: "" });

    const zero = gateway(0);
    const leaving = working("x", LOCAL);
    zero.add(leaving);
    expect(await zero.gw.prepareSwitch()).toBeNull();
    expect(leaving.wasAborted()).toBe(true);
  });

  it("an approval answer reaches the session that asked, even in the background", async () => {
    const { gw, internal, add } = gateway();
    add({ ...fakeSession(), sessionId: "front" });
    const bg = add({ ...fakeSession(), sessionId: "back" }, false);
    const answer = (bg as unknown as { gate(id: string, tool: string, input: object): Promise<unknown> }).gate("call-1", "bash", { command: "rm -rf x" });
    await Promise.resolve();
    expect(bg.status).toBe("approval");
    expect(internal.active?.hasApproval("call-1")).toBe(false);
    gw.approve("call-1", "deny", "nie");
    await expect(answer).resolves.toMatchObject({ block: true });
  });

  it("finished sessions beyond two are released, oldest first", async () => {
    const { internal, add } = gateway();
    add({ ...fakeSession(), sessionId: "front" });
    const idle = ["i1", "i2", "i3"].map((id, n) => {
      const h = add({ ...fakeSession(), sessionId: id }, false);
      h.lastSeen = 1000 + n; // i1 oldest
      return h;
    });
    (internal as unknown as { trimIdle(): void }).trimIdle();
    await new Promise((r) => setTimeout(r, 0));
    expect([...internal.hosts.keys()].sort()).toEqual(["front", "i2", "i3"]);
    expect(idle[0].isDisposed).toBe(true);
  });

  it("a session from memory comes back with its live transcript, open turn and pending approval", async () => {
    const { gw, internal, add, events } = gateway();
    internal.services = {};
    add({ ...fakeSession(), sessionId: "front" });
    const s = working("back", LOCAL, { sessionFile: "/s/back.jsonl" });
    s.state.messages = [{ role: "user", content: "zrób to", timestamp: 1 }];
    Object.assign(s.state, {
      streamingMessage: { role: "assistant", content: [{ type: "text", text: "Robię" }, { type: "toolCall", id: "t1", name: "bash", arguments: {} }], timestamp: 2 },
      pendingToolCalls: new Set(["t1"]),
    });
    (s as unknown as { sessionManager: unknown }).sessionManager = { getEntries: () => [] };
    const host = add(s, false);
    void (host as unknown as { gate(id: string, tool: string, input: object): Promise<unknown> }).gate("t1", "bash", { command: "touch x" });
    await Promise.resolve();
    events.length = 0;
    await gw.openSession("/s/back.jsonl");
    expect(internal.active).toBe(host);
    const h = events[0];
    if (h.kind !== "history") throw new Error("expected history first");
    expect(h.busy).toBe(true);
    expect(h.items[1]).toEqual({
      role: "assistant",
      parts: [
        { type: "text", text: "Robię" },
        { type: "tool", tool: { id: "t1", name: "bash", args: {}, status: "running", summary: "" } },
      ],
    });
    await new Promise((r) => setTimeout(r, 20)); // emitInit reads the git branch
    expect(events).toContainEqual({ kind: "approval_request", toolCallId: "t1", toolName: "bash", args: { command: "touch x" } });
  });
});

describe("PiGateway switching", () => {
  it("a run in the session being left does not stream into the new view while that one starts", async () => {
    const { internal, add, all } = gateway();
    const old = { ...fakeSession(), sessionId: "old" };
    old.state.isStreaming = true;
    add(old);
    let release!: () => void;
    const started = new Promise<void>((r) => (release = r));
    const orig = SessionHost.start;
    const next = { ...fakeSession(), sessionId: "new" };
    SessionHost.start = (async (env: HostEnv) => {
      await started; // extensions of the new session still loading
      return SessionHost.adopt(env, "/w", next as never);
    }) as typeof SessionHost.start;
    try {
      internal.services = { settingsManager: { getDefaultProvider: () => undefined, getDefaultModel: () => undefined }, modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined } };
      const switching = (internal as unknown as { startSession(cwd: string, sm: unknown): Promise<void> }).startSession("/w", {});
      await Promise.resolve();
      old.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "7\n28" } });
      release();
      await switching;
      expect(all.filter((x) => x.e.kind === "text_delta")).toEqual([]);
      expect(internal.active?.id).toBe("new");
      expect(internal.hosts.has("old")).toBe(true); // still working, in the background
    } finally {
      SessionHost.start = orig;
    }
  });
});

describe("PiGateway terminal", () => {
  /** A real session file in a tmp dir, a fake host on screen, SessionHost.start stubbed. */
  function setup() {
    const { gw, internal, events, add } = gateway();
    const dir = mkdtempSync(join(tmpdir(), "pi-gui-terminal-"));
    const sm = SessionManager.create("/w", dir);
    sm.newSession();
    const file = sm.getSessionFile()!;
    add({ ...fakeSession(), sessionId: sm.getSessionId(), sessionFile: file, sessionManager: sm });
    const reloaded: string[] = [];
    internal.services = {
      settingsManager: { getDefaultProvider: () => undefined, getDefaultModel: () => undefined },
      modelRuntime: { getAvailableSnapshot: () => [], getModel: () => undefined },
      resourceLoader: { reload: async () => reloaded.push("reload") },
    };
    // The real start boots extensions and MCP; the test only wants the session back on screen.
    const origStart = SessionHost.start;
    SessionHost.start = (async (env: HostEnv, cwd: string, m: SessionManager) =>
      SessionHost.adopt(env, cwd, { ...fakeSession(), prompt: async () => undefined, sessionId: m.getSessionId(), sessionFile: m.getSessionFile() } as never)) as typeof SessionHost.start;
    return {
      gw, internal, events, dir, file, reloaded,
      cleanup: () => {
        SessionHost.start = origStart;
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  /** EventEmitter standing in for the terminal's ChildProcess. */
  function fakeProc() {
    const proc = new EventEmitter() as EventEmitter & { killed: boolean; kill(): void };
    proc.killed = false;
    proc.kill = () => {
      proc.killed = true;
      process.nextTick(() => proc.emit("exit"));
    };
    return proc;
  }

  it("openInTerminal emits terminal_state, blocks prompt, brings the session back when the terminal exits", async () => {
    const { gw, internal, events, file, reloaded, cleanup } = setup();
    try {
      const proc = fakeProc();
      gw.spawnTerminal = () => proc as never;
      await gw.openInTerminal();
      expect(events).toContainEqual({ kind: "terminal_state", open: true, sessionPath: file });
      expect(gw.ready).toBe(false);
      expect(() => gw.prompt("hej")).toThrow("Sesja otwarta w terminalu");
      proc.emit("exit");
      await vi.waitFor(() => expect(events).toContainEqual({ kind: "terminal_state", open: false }));
      expect(reloaded).toEqual(["reload"]);
      expect(gw.ready).toBe(true);
      expect(internal.active?.path).toBe(file); // same session file back on screen
    } finally {
      cleanup();
    }
  });

  it("terminalFork opens a copy (--fork): the GUI keeps the session, no terminal_state, exit restores nothing", async () => {
    const { gw, internal, events, file, cleanup } = setup();
    try {
      const proc = fakeProc();
      let argv: string[] = [];
      gw.spawnTerminal = (a: string[]) => {
        argv = a;
        return proc as never;
      };
      internal.config = { get: () => ({ terminalFork: true }) };
      await gw.openInTerminal();
      // --session became --fork after placeholder substitution
      expect(argv).toEqual(["konsole", "--separate", "--workdir", "/w", "-e", "pi", "--fork", file]);
      expect(events).toEqual([]); // no terminal_state — the GUI was never blocked
      expect(gw.ready).toBe(true);
      expect(internal.active?.path).toBe(file); // the session was not released — the GUI keeps it
      expect(internal.terminal).toBeNull(); // nothing tracked to restore later
      proc.emit("exit"); // the copy exits — nothing is restored, nothing is sent
      await new Promise((r) => setTimeout(r, 25));
      expect(events).toEqual([]);
      expect(internal.active?.path).toBe(file);
    } finally {
      cleanup();
    }
  });

  it("a fork copy that fails to spawn reports the error (terminal_state) without blocking the GUI", async () => {
    const { gw, internal, events, file, cleanup } = setup();
    try {
      const proc = new EventEmitter() as EventEmitter & { killed: boolean; kill(): void };
      proc.killed = false;
      proc.kill = () => {
        proc.killed = true;
      };
      gw.spawnTerminal = () => proc as never;
      internal.config = { get: () => ({ terminalFork: true }) };
      await gw.openInTerminal();
      proc.emit("error", new Error("spawn kitty ENOENT"));
      await vi.waitFor(() => expect(events).toContainEqual({ kind: "terminal_state", open: false, error: "spawn kitty ENOENT" }));
      expect(gw.ready).toBe(true);
      expect(internal.active?.path).toBe(file); // the GUI never lost the session
    } finally {
      cleanup();
    }
  });

  it("terminalTakeback kills the process and restores the session exactly once", async () => {
    const { gw, internal, events, file, cleanup } = setup();
    try {
      const proc = fakeProc();
      gw.spawnTerminal = () => proc as never;
      await gw.openInTerminal();
      await gw.terminalTakeback();
      expect(proc.killed).toBe(true);
      expect(internal.active?.path).toBe(file);
      const closed = () => events.filter((e) => e.kind === "terminal_state" && !e.open).length;
      expect(closed()).toBe(1);
      await gw.terminalTakeback(); // second one is a no-op (the exit event is too)
      expect(closed()).toBe(1);
      expect(internal.active?.path).toBe(file);
    } finally {
      cleanup();
    }
  });

  it("a terminal that dies with a spawn error (missing console) reports it and unblocks the GUI", async () => {
    const { gw, internal, events, file, cleanup } = setup();
    try {
      const proc = new EventEmitter() as EventEmitter & { killed: boolean; kill(): void };
      proc.killed = false;
      proc.kill = () => {
        proc.killed = true;
      };
      gw.spawnTerminal = () => proc as never;
      await gw.openInTerminal();
      // No "exit" follows — only the spawn error (e.g. konsole not installed).
      proc.emit("error", new Error("spawn konsole ENOENT"));
      await vi.waitFor(() => expect(events).toContainEqual({ kind: "terminal_state", open: false, error: "spawn konsole ENOENT" }));
      expect(gw.ready).toBe(true);
      expect(internal.active?.path).toBe(file);
      await gw.prompt("hej"); // the GUI can write to the session again
    } finally {
      cleanup();
    }
  });

  it("a session file pi started in the terminal (/new) is picked up on return", async () => {
    const { gw, internal, events, dir, cleanup } = setup();
    try {
      const proc = fakeProc();
      gw.spawnTerminal = () => proc as never;
      await gw.openInTerminal();
      // pi opens a fresh session in the same dir while the terminal is open
      const sm2 = SessionManager.create("/w", dir);
      sm2.newSession();
      // The SDK flushes the file on the first assistant message (user-only entries are deferred).
      sm2.appendMessage({ role: "user", content: "w terminalu", timestamp: Date.now() });
      sm2.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], api: "openai", provider: "test", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
      const file2 = sm2.getSessionFile()!;
      utimesSync(file2, Date.now() / 1000 + 60, Date.now() / 1000 + 60); // same-millisecond mtime is not "newer"
      proc.emit("exit");
      await vi.waitFor(() => expect(events).toContainEqual({ kind: "terminal_state", open: false }));
      expect(internal.active?.path).toBe(file2);
    } finally {
      cleanup();
    }
  });
});

describe("SessionHost: a message sent while the run is still starting", () => {
  // Extensions (MCP) can take seconds before the first turn. A second message in that window used
  // to go to the SDK as a mid-run follow-up with the "sent while you were working" note.
  function starting() {
    const { gw, events, add } = gateway();
    const prompts: string[] = [];
    const followUps: string[] = [];
    let endRun = () => {};
    const base = fakeSession();
    const session = Object.assign(base, {
      steer: vi.fn(async () => undefined),
      followUp: vi.fn(async (text: string) => void followUps.push(text)),
      prompt: vi.fn(async (text: string) => {
        prompts.push(text);
        base.state.isStreaming = true;
        base.push({ type: "turn_start" });
        await new Promise<void>((r) => (endRun = r));
        base.state.isStreaming = false;
      }),
    });
    const host = add(session);
    let ready = () => {};
    host.extensionsReady = new Promise<void>((r) => (ready = r));
    return { gw, session, events, prompts, followUps, ready: () => ready(), endRun: () => endRun() };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("waits locally, then goes out as an ordinary follow-up once the run streams", async () => {
    const t = starting();
    const first = t.gw.prompt("zrób A");
    await tick();
    await t.gw.prompt("i jeszcze B");
    expect(t.session.followUp).not.toHaveBeenCalled();
    expect(t.session.steer).not.toHaveBeenCalled();
    expect(t.events).toContainEqual({ kind: "queue", steering: 0, followUp: 1 });
    t.ready();
    await tick();
    expect(t.prompts).toEqual(["zrób A"]);
    expect(t.followUps).toEqual(["i jeszcze B"]); // no mid-run note
    t.endRun();
    await first;
  });

  it("with no run at all (an extension command), the waiting message becomes the next prompt", async () => {
    const t = starting();
    t.session.prompt = vi.fn(async (text: string) => void t.prompts.push(text)) as never;
    const first = t.gw.prompt("/memory");
    await tick();
    await t.gw.prompt("potem to");
    t.ready();
    await first;
    await tick();
    expect(t.prompts).toEqual(["/memory", "potem to"]);
    expect(t.session.followUp).not.toHaveBeenCalled();
  });

  it("Stop drops what was waiting", async () => {
    const t = starting();
    const first = t.gw.prompt("zrób A");
    await tick();
    await t.gw.prompt("B");
    await t.gw.abort();
    t.ready();
    await tick();
    expect(t.followUps).toEqual([]);
    t.endRun();
    await first;
  });
});
