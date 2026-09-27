import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientCommand } from "../../shared/protocol";
import { setLang } from "../../shared/i18n";
import { CLOSE_BRIDGE_BUSY, CLOSE_SIDECAR_EXIT, createWsTransport, downFromClose, downReason, withId } from "./transport";

describe("withId", () => {
  it("builds a valid command for every variant", () => {
    const cases: [ReturnType<typeof withId>, string][] = [
      [withId({ cmd: "init", cwd: "/w" }, 1), "init"],
      [withId({ cmd: "prompt", text: "x" }, 2), "prompt"],
      [withId({ cmd: "abort" }, 3), "abort"],
      [withId({ cmd: "status" }, 4), "status"],
      [withId({ cmd: "sessions_list" }, 5), "sessions_list"],
      [withId({ cmd: "session_open", path: "/s" }, 6), "session_open"],
      [withId({ cmd: "session_new" }, 7), "session_new"],
      [withId({ cmd: "history" }, 8), "history"],
      [withId({ cmd: "dispose" }, 9), "dispose"],
    ];
    for (const [cmd, name] of cases) {
      expect(cmd.cmd).toBe(name);
      expect(cmd.id).toBeGreaterThan(0);
    }
    // round-trip: everything serializes back to the same discriminant
    for (const [cmd] of cases) {
      expect(JSON.parse(JSON.stringify(cmd)).cmd).toBe(cmd.cmd);
    }
  });
});

/** Minimal in-memory WebSocket stand-in driving the real reconnect logic. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  url: string;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "" });
  }
  /** Simulate the server dropping the connection. */
  drop(code = 1006, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
  /** Simulate the socket finishing its handshake. */
  fireOpen() {
    this.onopen?.();
  }
}

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.restoreAllMocks();
});

describe("createWsTransport", () => {
  it("fires onOpen after connect and sends commands as JSON lines", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const t = createWsTransport("ws://127.0.0.1:9876");
    const opened: number[] = [];
    const t2 = vi.fn();
    t.onOpen(() => opened.push(1));
    t.onMessage(t2);
    FakeWebSocket.instances[0].fireOpen();
    expect(opened).toEqual([1]);

    t.send({ cmd: "status" });
    const sent = JSON.parse(FakeWebSocket.instances[0].sent[0]) as ClientCommand;
    expect(sent).toMatchObject({ cmd: "status" });
    expect(typeof sent.id).toBe("number");

    // inbound message reaches onMessage
    FakeWebSocket.instances[0].onmessage?.({ data: JSON.stringify({ id: 1, ok: true }) });
    expect(t2).toHaveBeenCalledWith({ id: 1, ok: true });
    t.close();
  });

  it("reconnects after a dropped connection and fires onOpen again", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
    const t = createWsTransport("ws://127.0.0.1:9876");
    let opens = 0;
    t.onOpen(() => opens++);
    FakeWebSocket.instances[0].fireOpen();
    expect(opens).toBe(1);

    FakeWebSocket.instances[0].drop();
    expect(FakeWebSocket.instances).toHaveLength(1); // not yet — backoff timer pending
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].fireOpen();
    expect(opens).toBe(2);
    t.close();
  });

  it("reports a dead sidecar once per connection, with the bridge's reason", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
    const t = createWsTransport("ws://127.0.0.1:9876");
    const downs: unknown[] = [];
    t.onDown((d) => downs.push(d));
    FakeWebSocket.instances[0].drop(); // never opened: the bridge is just not up yet
    expect(downs).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    FakeWebSocket.instances[1].fireOpen();
    FakeWebSocket.instances[1].drop(CLOSE_SIDECAR_EXIT, JSON.stringify({ why: "kod wyjścia 1", restarting: true }));
    expect(downs).toEqual([{ why: "kod wyjścia 1", restarting: true }]);
    await vi.advanceTimersByTimeAsync(500);
    FakeWebSocket.instances[2].drop(); // reconnect attempt that fails: not a second "down"
    expect(downs).toHaveLength(1);
    t.close();
  });
});

describe("createWsTransport after close()", () => {
  it("a reconnect that was pending does not bring a closed transport back", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
    const t = createWsTransport("ws://127.0.0.1:9876");
    FakeWebSocket.instances[0].fireOpen();
    FakeWebSocket.instances[0].drop(); // reconnect timer armed
    t.close(); // e.g. a hot reload unmounts the app
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("being refused because another window holds the bridge is not a dead sidecar", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const t = createWsTransport("ws://127.0.0.1:9876");
    const downs: unknown[] = [];
    t.onDown((d) => downs.push(d));
    FakeWebSocket.instances[0].fireOpen();
    FakeWebSocket.instances[0].drop(CLOSE_BRIDGE_BUSY, "bridge in use by another window");
    expect(downs).toEqual([]);
    t.close();
  });
});

describe("downFromClose", () => {
  it("reads the bridge's reason, anything else is a broken link", () => {
    expect(downFromClose(CLOSE_SIDECAR_EXIT, JSON.stringify({ why: "sygnał SIGKILL", restarting: false }))).toEqual({ why: "sygnał SIGKILL", restarting: false });
    expect(downFromClose(CLOSE_SIDECAR_EXIT, "garbage")).toEqual({ why: "garbage", restarting: true });
    expect(downFromClose(1006, "")).toEqual({ why: "połączenie z mostkiem zerwane", restarting: true });
  });
});

describe("downReason", () => {
  afterEach(() => setLang("pl"));

  it("words the exit code in the UI language, not the shell's", () => {
    setLang("en");
    expect(downReason({ why: "exit code 1", code: 1, restarting: true })).toBe("exit code 1");
    expect(downReason({ why: "killed by a signal", code: null, restarting: true })).toBe("killed by a signal");
    setLang("pl");
    expect(downReason({ why: "exit code 1", code: 1, restarting: true })).toBe("kod wyjścia 1");
    expect(downReason(downFromClose(CLOSE_SIDECAR_EXIT, JSON.stringify({ why: "x", code: 7, restarting: true })))).toBe("kod wyjścia 7");
  });

  it("falls back to `why` from an older shell, and names the fix for a failed restart", () => {
    expect(downReason({ why: "kod wyjścia 3", restarting: false })).toBe("kod wyjścia 3");
    const startup = { kind: "node_missing", node: "/opt/n", required: "22.19.0", from_env: true } as const;
    expect(downReason({ why: "", restarting: false, startup })).toContain("PI_CODE_NODE wskazuje na /opt/n");
  });
});
