// Shared protocol between sidecar (pi SDK) and UI. JSON lines over stdio.

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** ClientCommand without the id: id is assigned by the transport. */
export type ClientCommandInput = DistributiveOmit<ClientCommand, "id">;

export type ClientCommand =
  | { id: number; cmd: "init"; cwd?: string; sessionFile?: string }
  | { id: number; cmd: "prompt"; text: string; behavior?: "steer" | "followUp" }
  | { id: number; cmd: "abort" }
  | { id: number; cmd: "status" }
  | { id: number; cmd: "dispose" };

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
