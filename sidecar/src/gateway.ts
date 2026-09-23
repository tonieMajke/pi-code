import {
  createAgentSession,
  createAgentSessionServices,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { PiEvent } from "./protocol.js";

/**
 * Thin wrapper around a pi AgentSession: one command surface in,
 * normalized PiEvent stream out.
 */
export class PiGateway {
  private session: AgentSession | null = null;

  get ready(): boolean {
    return this.session !== null;
  }

  get busy(): boolean {
    return this.session?.state.isStreaming ?? false;
  }

  async init(onEvent: (e: PiEvent) => void, cwd?: string): Promise<void> {
    if (this.session) return;
    const workingDir = cwd ?? process.cwd();
    const services = await createAgentSessionServices({ cwd: workingDir });
    const provider = services.settingsManager.getDefaultProvider();
    const modelId = services.settingsManager.getDefaultModel();
    const model =
      provider && modelId
        ? services.modelRuntime.getModel(provider, modelId)
        : undefined;
    if (!model) {
      throw new Error(
        `default model not found: ${provider ?? "?"}/${modelId ?? "?"}`,
      );
    }
    const { session } = await createAgentSession({
      cwd,
      model,
      modelRuntime: services.modelRuntime,
      settingsManager: services.settingsManager,
    });
    this.session = session;
    this.subscribe(session, onEvent);
    onEvent({
      kind: "init_done",
      cwd: workingDir,
      model: session.model?.id ?? "",
      sessionId: session.sessionId ?? "",
    });
  }

  async prompt(text: string, behavior?: "steer" | "followUp"): Promise<void> {
    const s = this.requireSession();
    // SDK rejects guessing: while streaming, default to followUp (do not interrupt current run).
    const effective = behavior ?? (s.state.isStreaming ? "followUp" : undefined);
    await s.prompt(text, effective ? { streamingBehavior: effective } : undefined);
  }

  async abort(): Promise<void> {
    const s = this.requireSession();
    if (s.state.isStreaming) await s.abort();
  }

  dispose(): void {
    this.session?.dispose();
    this.session = null;
  }

  private requireSession(): AgentSession {
    if (!this.session) throw new Error("session not initialized");
    return this.session;
  }

  private subscribe(session: AgentSession, onEvent: (e: PiEvent) => void): void {
    session.subscribe((event) => {
      switch (event.type) {
        case "message_update": {
          const a = event.assistantMessageEvent;
          if (a.type === "text_delta") onEvent({ kind: "text_delta", delta: a.delta });
          else if (a.type === "thinking_delta") onEvent({ kind: "thinking_delta", delta: a.delta });
          return;
        }
        case "message_end":
          onEvent({ kind: "message_end" });
          return;
        case "tool_execution_start":
          onEvent({
            kind: "tool_start",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          });
          return;
        case "tool_execution_update":
          onEvent({
            kind: "tool_update",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            partialResult: event.partialResult,
          });
          return;
        case "tool_execution_end":
          onEvent({
            kind: "tool_end",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: { isError: event.isError, text: summarizeToolResult(event.result) },
          });
          return;
        case "turn_start":
          onEvent({ kind: "turn_start" });
          return;
        case "turn_end":
          onEvent({ kind: "turn_end" });
          return;
        case "agent_end":
          onEvent({ kind: "agent_end" });
          return;
        case "agent_settled":
          onEvent({ kind: "settled" });
          return;
        case "queue_update":
          onEvent({
            kind: "queue",
            steering: event.steering.length,
            followUp: event.followUp.length,
          });
          return;
        default:
          return;
      }
    });
  }
}

function summarizeToolResult(result: unknown, max = 400): string {
  const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  const text = content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
