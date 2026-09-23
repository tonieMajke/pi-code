import {
  createAgentSession,
  createAgentSessionServices,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { HistoryItem, PiEvent, SessionSummary } from "../../shared/protocol.js";

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

  private initCwd = process.cwd();
  private services: Awaited<ReturnType<typeof createAgentSessionServices>> | null =
    null;

  async init(onEvent: (e: PiEvent) => void, cwd?: string): Promise<void> {
    // Idempotent: a re-init (e.g. a second UI client) re-emits init_done
    // so the caller can always learn the current model/cwd.
    if (this.session) {
      this.emitInit(onEvent);
      return;
    }
    const workingDir = cwd ?? process.cwd();
    this.initCwd = workingDir;
    this.services = await createAgentSessionServices({ cwd: workingDir });
    const model = this.resolveDefaultModel();
    const { session } = await createAgentSession({
      cwd: workingDir,
      model,
      modelRuntime: this.services.modelRuntime,
      settingsManager: this.services.settingsManager,
    });
    this.session = session;
    this.subscribe(session, onEvent);
    this.emitInit(onEvent);
  }

  /** Rendered transcript of the active session (system/tool plumbing collapsed). */
  history(): HistoryItem[] {
    const s = this.requireSession();
    const items: HistoryItem[] = [];
    for (const msg of s.state.messages) {
      if (msg.role === "user") {
        items.push({ role: "user", text: userText(msg.content) });
      } else if (msg.role === "assistant") {
        const item: HistoryItem = {
          role: "assistant",
          thinking: msg.content
            .filter((c): c is Extract<typeof c, { type: "thinking" }> => c.type === "thinking")
            .map((c) => c.thinking)
            .join("\n"),
          text: msg.content
            .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
            .map((c) => c.text)
            .join("\n"),
          tools: msg.content
            .filter((c): c is Extract<typeof c, { type: "toolCall" }> => c.type === "toolCall")
            .map((c) => ({ id: c.id, name: c.name, args: c.arguments, status: "ok" as const, summary: "" })),
        };
        items.push(item);
      } else if (msg.role === "toolResult") {
        const assistant = [...items].reverse().find((i) => i.role === "assistant");
        if (assistant && assistant.role === "assistant") {
          const tool = assistant.tools.find((t) => t.id === msg.toolCallId);
          if (tool) {
            tool.status = msg.isError ? "error" : "ok";
            tool.summary = summarizeToolResult({ content: msg.content }, 400);
          }
        }
      }
    }
    return items;
  }

  async listSessions(): Promise<SessionSummary[]> {
    // All sessions across all project dirs (sidebar is global, like Claude desktop).
    const infos = await SessionManager.listAll();
    return infos.map((s) => ({
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      modified: s.modified.toISOString(),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage,
    }));
  }

  /** Replace the active session with a persisted one (sidebar "open"). */
  async openSession(onEvent: (e: PiEvent) => void, path: string): Promise<void> {
    if (!this.services) throw new Error("not initialized — send init first");
    const sessionManager = SessionManager.open(path);
    const model = this.resolveDefaultModel();
    this.dispose();
    const { session } = await createAgentSession({
      cwd: this.initCwd,
      model,
      modelRuntime: this.services.modelRuntime,
      settingsManager: this.services.settingsManager,
      sessionManager,
    });
    this.session = session;
    this.subscribe(session, onEvent);
    this.emitInit(onEvent);
  }

  private resolveDefaultModel() {
    const settings = this.services!.settingsManager;
    const provider = settings.getDefaultProvider();
    const modelId = settings.getDefaultModel();
    const model =
      provider && modelId
        ? this.services!.modelRuntime.getModel(provider, modelId)
        : undefined;
    if (!model) {
      throw new Error(`default model not found: ${provider ?? "?"}/${modelId ?? "?"}`);
    }
    return model;
  }

  private emitInit(onEvent: (e: PiEvent) => void): void {
    onEvent({
      kind: "init_done",
      cwd: this.initCwd,
      model: this.session?.model?.id ?? "",
      sessionId: this.session?.sessionId ?? "",
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

function userText(content: string | { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
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
