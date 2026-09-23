// Shared protocol between sidecar (pi SDK) and UI. JSON lines over stdio.

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** ClientCommand without the id: id is assigned by the transport. */
export type ClientCommandInput = DistributiveOmit<ClientCommand, "id">;

export type ClientCommand =
  | { id: number; cmd: "init"; cwd?: string; sessionFile?: string }
  | { id: number; cmd: "prompt"; text: string; behavior?: "steer" | "followUp" }
  | { id: number; cmd: "abort" }
  | { id: number; cmd: "status" }
  | { id: number; cmd: "sessions_list"; cwd?: string }
  | { id: number; cmd: "session_open"; path: string }
  | { id: number; cmd: "session_new"; cwd?: string }
  | { id: number; cmd: "history" }
  | { id: number; cmd: "dispose" };

/** One rendered item of a restored session transcript. */
export type HistoryItem =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      thinking: string;
      text: string;
      tools: { id: string; name: string; args: unknown; status: "ok" | "error"; summary: string }[];
    };

/** Summary of a persisted pi session (from SessionManager.list). */
export type SessionSummary = {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
};

export type ToolResultSummary = {
  isError: boolean;
  text: string;
};

/** Normalized events the sidecar emits to the UI. */
export type PiEvent =
  | { kind: "init_done"; cwd: string; model: string; sessionId: string }
  | { kind: "text_delta"; delta: string }
  | { kind: "thinking_delta"; delta: string }
  | { kind: "message_end" }
  | { kind: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { kind: "tool_update"; toolCallId: string; toolName: string; partialResult: unknown }
  | { kind: "tool_end"; toolCallId: string; toolName: string; result: ToolResultSummary }
  | { kind: "turn_start" }
  | { kind: "turn_end" }
  | { kind: "agent_end" }
  | { kind: "settled" }
  | { kind: "queue"; steering: number; followUp: number }
  | { kind: "status"; busy: boolean };

export type SidecarOut =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: string }
  | { event: PiEvent };
