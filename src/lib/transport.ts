import type { ClientCommand, ClientCommandInput, SidecarOut } from "../../shared/protocol";

/** One command, its reply as a promise (App keeps one pending request per command name). */
export type PiRequest = <T = unknown>(cmd: ClientCommandInput) => Promise<T>;

export interface PiTransport {
  send(cmd: ClientCommandInput): void;
  onMessage(cb: (msg: SidecarOut) => void): () => void;
  /** Fired on every (re)connect — safe point to send the boot sequence. */
  onOpen(cb: () => void): () => void;
  close(): void;
}

// Explicit per-variant construction: spreading a union does not preserve
// discriminant correlation, so TS rejects `{ ...cmd, id }` as ClientCommand.
export function withId(cmd: ClientCommandInput, id: number): ClientCommand {
  switch (cmd.cmd) {
    case "init":
      return { id, cmd: "init", cwd: cmd.cwd, sessionFile: cmd.sessionFile, lang: cmd.lang };
    case "lang_set":
      return { id, cmd: "lang_set", lang: cmd.lang };
    case "memory_get":
      return { id, cmd: "memory_get" };
    case "memory_set":
      return { id, cmd: "memory_set", entries: cmd.entries };
    case "memory_learn":
      return { id, cmd: "memory_learn" };
    case "agents_set":
      return { id, cmd: "agents_set", scope: cmd.scope, text: cmd.text };
    case "providers_list":
      return { id, cmd: "providers_list" };
    case "provider_key":
      return { id, cmd: "provider_key", provider: cmd.provider, key: cmd.key };
    case "provider_logout":
      return { id, cmd: "provider_logout", provider: cmd.provider };
    case "endpoint_probe":
      return { id, cmd: "endpoint_probe", baseUrl: cmd.baseUrl, apiKey: cmd.apiKey };
    case "endpoint_add":
      return { id, cmd: "endpoint_add", endpoint: cmd.endpoint };
    case "endpoint_remove":
      return { id, cmd: "endpoint_remove", name: cmd.name };
    case "onboarding_get":
      return { id, cmd: "onboarding_get" };
    case "onboarding_done":
      return { id, cmd: "onboarding_done" };
    case "prompt":
      return { id, cmd: "prompt", text: cmd.text, images: cmd.images, behavior: cmd.behavior, session: cmd.session };
    case "mode_set":
      return { id, cmd: "mode_set", mode: cmd.mode };
    case "approve":
      return { id, cmd: "approve", toolCallId: cmd.toolCallId, decision: cmd.decision, reason: cmd.reason, session: cmd.session };
    case "abort":
      return { id, cmd: "abort", session: cmd.session };
    case "status":
      return { id, cmd: "status" };
    case "sessions_list":
      return { id, cmd: "sessions_list", cwd: cmd.cwd };
    case "session_open":
      return { id, cmd: "session_open", path: cmd.path, stop: cmd.stop };
    case "session_new":
      return { id, cmd: "session_new", cwd: cmd.cwd, stop: cmd.stop };
    case "session_rename":
      return { id, cmd: "session_rename", name: cmd.name };
    case "history":
      return { id, cmd: "history" };
    case "models_list":
      return { id, cmd: "models_list" };
    case "model_set":
      return { id, cmd: "model_set", provider: cmd.provider, modelId: cmd.modelId };
    case "rewind":
      return { id, cmd: "rewind", fromEnd: cmd.fromEnd };
    case "git_changes":
      return { id, cmd: "git_changes" };
    case "git_revert":
      return { id, cmd: "git_revert", path: cmd.path };
    case "git_stage":
      return { id, cmd: "git_stage", paths: cmd.paths };
    case "git_unstage":
      return { id, cmd: "git_unstage", paths: cmd.paths };
    case "git_commit":
      return { id, cmd: "git_commit", message: cmd.message };
    case "git_commit_message":
      return { id, cmd: "git_commit_message" };
    case "files_list":
      return { id, cmd: "files_list" };
    case "router_status":
      return { id, cmd: "router_status" };
    case "notify":
      return { id, cmd: "notify", title: cmd.title, body: cmd.body };
    case "settings_get":
      return { id, cmd: "settings_get" };
    case "settings_set":
      return { id, cmd: "settings_set", patch: cmd.patch };
    case "compact":
      return { id, cmd: "compact", instructions: cmd.instructions };
    case "commands_list":
      return { id, cmd: "commands_list" };
    case "fork_points":
      return { id, cmd: "fork_points" };
    case "session_fork":
      return { id, cmd: "session_fork", entryId: cmd.entryId };
    case "history_image":
      return { id, cmd: "history_image", ref: cmd.ref };
    case "sidebar_get":
      return { id, cmd: "sidebar_get" };
    case "sidebar_set":
      return { id, cmd: "sidebar_set", state: cmd.state };
    case "session_delete":
      return { id, cmd: "session_delete", path: cmd.path };
    case "dir_check":
      return { id, cmd: "dir_check", path: cmd.path };
    case "session_clone":
      return { id, cmd: "session_clone" };
    case "session_handoff":
      return { id, cmd: "session_handoff", goal: cmd.goal };
    case "session_stats":
      return { id, cmd: "session_stats" };
    case "export_html":
      return { id, cmd: "export_html" };
    case "reload":
      return { id, cmd: "reload" };
    case "ui_response":
      return { id, cmd: "ui_response", requestId: cmd.requestId, answer: cmd.answer, session: cmd.session };
    case "escalate":
      return { id, cmd: "escalate", model: cmd.model, reason: cmd.reason };
    case "checkpoint_restore":
      return { id, cmd: "checkpoint_restore", checkpoint: cmd.checkpoint };
    case "appearance_get":
      return { id, cmd: "appearance_get" };
    case "appearance_set":
      return { id, cmd: "appearance_set", patch: cmd.patch };
    case "appearance_image":
      return { id, cmd: "appearance_image", dataUrl: cmd.dataUrl };
    case "stats_query":
      return { id, cmd: "stats_query", range: cmd.range };
    case "voice_get":
      return { id, cmd: "voice_get" };
    case "voice_set":
      return { id, cmd: "voice_set", patch: cmd.patch };
    case "voice_key":
      return { id, cmd: "voice_key", provider: cmd.provider, key: cmd.key };
    case "voice_test":
      return { id, cmd: "voice_test" };
    case "voice_inputs":
      return { id, cmd: "voice_inputs" };
    case "voice_start":
      return { id, cmd: "voice_start" };
    case "voice_stop":
      return { id, cmd: "voice_stop" };
    case "voice_cancel":
      return { id, cmd: "voice_cancel" };
    case "dispose":
      return { id, cmd: "dispose" };
  }
}

/**
 * Dev transport: WebSocket to dev/ws-bridge.mjs (wraps sidecar stdio).
 * Reconnects with backoff when the bridge restarts; `onOpen` fires again
 * so the UI can re-send its boot sequence.
 */
export function createWsTransport(url: string): PiTransport {
  let ws: WebSocket | null = null;
  let nextId = 1;
  let intentional = false;
  let attempt = 0;
  const listeners = new Set<(m: SidecarOut) => void>();
  const openListeners = new Set<() => void>();

  function connect(): void {
    ws = new WebSocket(url);
    ws.onopen = () => {
      attempt = 0;
      openListeners.forEach((l) => l());
    };
    ws.onmessage = (e) => {
      let msg: SidecarOut;
      try {
        msg = JSON.parse(String(e.data)) as SidecarOut;
      } catch {
        return;
      }
      listeners.forEach((l) => l(msg));
    };
    ws.onclose = () => {
      if (intentional) return;
      const delay = Math.min(4000, 500 * 2 ** attempt++);
      setTimeout(connect, delay);
    };
  }
  connect();

  return {
    send(cmd) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(withId(cmd, nextId++)));
      }
    },
    onMessage(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    onOpen(cb) {
      openListeners.add(cb);
      return () => {
        openListeners.delete(cb);
      };
    },
    close() {
      intentional = true;
      ws?.close();
    },
  };
}
