import readline from "node:readline";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AppearanceStore } from "./appearance.js";
import { PiGateway } from "./gateway.js";
import { gitChanges, gitRevert, listFiles, notify, routerStatus } from "./workspace.js";
import type { ClientCommand, CommandName, PiEvent, SidecarOut } from "../../shared/protocol.js";

// stdout is the JSONL protocol; keep stray logging (pi extensions, libraries) off it.
console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);

const gateway = new PiGateway();
const appearance = new AppearanceStore(process.env.PI_GUI_APPEARANCE_DIR ?? getAgentDir());

function out(msg: SidecarOut): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const emit = (e: PiEvent) => out({ event: e });

function reply(id: number, cmd: CommandName | undefined, ok: boolean, result?: unknown, error?: string): void {
  out(ok ? { id, cmd, ok: true, result } : { id, cmd, ok: false, error: error ?? "unknown error" });
}

const KNOWN = new Set<CommandName>([
  "init",
  "prompt",
  "abort",
  "status",
  "sessions_list",
  "session_open",
  "session_new",
  "session_rename",
  "mode_set",
  "approve",
  "history",
  "models_list",
  "model_set",
  "rewind",
  "git_changes",
  "git_revert",
  "files_list",
  "router_status",
  "notify",
  "settings_get",
  "settings_set",
  "compact",
  "escalate",
  "checkpoint_restore",
  "appearance_get",
  "appearance_set",
  "appearance_image",
  "commands_list",
  "fork_points",
  "session_fork",
  "session_clone",
  "session_stats",
  "export_html",
  "reload",
  "ui_response",
  "dispose",
]);

function requireReady(): void {
  if (!gateway.ready) throw new Error("not initialized — send init first");
}

async function handle(cmd: ClientCommand): Promise<void> {
  try {
    switch (cmd.cmd) {
      case "init":
        await gateway.init(emit, cmd.cwd);
        reply(cmd.id, cmd.cmd, true, { ready: true });
        return;
      case "prompt":
        requireReady();
        // prompt() resolves only when the whole run ends. Don't hold the command
        // queue for that long — abort/steer/sessions_list must get through meanwhile.
        gateway
          .prompt(cmd.text, cmd.images, cmd.behavior)
          .then(() => reply(cmd.id, cmd.cmd, true, { done: true }))
          .catch((err) => reply(cmd.id, cmd.cmd, false, undefined, errText(err)));
        return;
      case "mode_set":
        gateway.setMode(cmd.mode);
        reply(cmd.id, cmd.cmd, true, { mode: cmd.mode });
        return;
      case "approve":
        gateway.approve(cmd.toolCallId, cmd.decision, cmd.reason);
        reply(cmd.id, cmd.cmd, true, { done: true });
        return;
      case "abort":
        await gateway.abort();
        reply(cmd.id, cmd.cmd, true, { done: true });
        return;
      case "status":
        reply(cmd.id, cmd.cmd, true, { busy: gateway.busy, ready: gateway.ready });
        return;
      case "sessions_list":
        reply(cmd.id, cmd.cmd, true, await gateway.listSessions());
        return;
      case "session_open":
        requireReady();
        await gateway.abort();
        await gateway.openSession(emit, cmd.path);
        reply(cmd.id, cmd.cmd, true, { done: true });
        return;
      case "session_new":
        requireReady();
        await gateway.abort();
        await gateway.newSession(emit, cmd.cwd);
        reply(cmd.id, cmd.cmd, true, { done: true });
        return;
      case "session_rename":
        requireReady();
        await gateway.rename(emit, cmd.name);
        reply(cmd.id, cmd.cmd, true, { done: true });
        return;
      case "history":
        requireReady();
        reply(cmd.id, cmd.cmd, true, gateway.history());
        return;
      case "models_list":
        requireReady();
        reply(cmd.id, cmd.cmd, true, await gateway.listModels());
        return;
      case "model_set":
        requireReady();
        await gateway.setModel(emit, cmd.provider, cmd.modelId);
        reply(cmd.id, cmd.cmd, true, { done: true });
        return;
      case "rewind":
        requireReady();
        reply(cmd.id, cmd.cmd, true, { text: await gateway.rewind(emit, cmd.fromEnd) });
        return;
      case "git_changes":
        reply(cmd.id, cmd.cmd, true, await gitChanges(gateway.workingDir));
        return;
      case "git_revert":
        await gitRevert(gateway.workingDir, cmd.path);
        reply(cmd.id, cmd.cmd, true, await gitChanges(gateway.workingDir));
        return;
      case "files_list":
        reply(cmd.id, cmd.cmd, true, await listFiles(gateway.workingDir));
        return;
      case "router_status":
        reply(cmd.id, cmd.cmd, true, await routerStatus(gateway.baseUrl));
        return;
      case "notify":
        await notify(cmd.title, cmd.body);
        reply(cmd.id, cmd.cmd, true, { done: true });
        return;
      // Appearance does not need a session: the UI applies it before init finishes.
      case "appearance_get":
        reply(cmd.id, cmd.cmd, true, appearance.get());
        return;
      case "appearance_set":
        reply(cmd.id, cmd.cmd, true, appearance.update(cmd.patch));
        return;
      case "appearance_image":
        reply(cmd.id, cmd.cmd, true, appearance.setImage(cmd.dataUrl));
        return;
      case "settings_get":
        requireReady();
        reply(cmd.id, cmd.cmd, true, gateway.settings());
        return;
      case "settings_set":
        requireReady();
        reply(cmd.id, cmd.cmd, true, await gateway.updateSettings(emit, cmd.patch));
        return;
      case "compact":
        requireReady();
        await gateway.compact(emit, cmd.instructions);
        reply(cmd.id, cmd.cmd, true, gateway.settings());
        return;
      case "escalate":
        requireReady();
        // Like prompt: runs a whole agent loop, must not hold the command queue.
        gateway
          .escalate(cmd.model, cmd.reason)
          .then(() => reply(cmd.id, cmd.cmd, true, { done: true }))
          .catch((err) => reply(cmd.id, cmd.cmd, false, undefined, errText(err)));
        return;
      case "checkpoint_restore":
        requireReady();
        reply(cmd.id, cmd.cmd, true, { files: await gateway.restoreCheckpoint(cmd.checkpoint) });
        return;
      case "commands_list":
        requireReady();
        reply(cmd.id, cmd.cmd, true, gateway.commands());
        return;
      case "fork_points":
        requireReady();
        reply(cmd.id, cmd.cmd, true, gateway.forkPoints());
        return;
      case "session_fork":
        requireReady();
        reply(cmd.id, cmd.cmd, true, { text: await gateway.fork(emit, cmd.entryId) });
        return;
      case "session_clone":
        requireReady();
        await gateway.clone(emit);
        reply(cmd.id, cmd.cmd, true, { done: true });
        return;
      case "session_stats":
        requireReady();
        reply(cmd.id, cmd.cmd, true, gateway.stats());
        return;
      case "export_html":
        requireReady();
        reply(cmd.id, cmd.cmd, true, { path: await gateway.exportHtml() });
        return;
      case "reload":
        requireReady();
        await gateway.reload(emit);
        reply(cmd.id, cmd.cmd, true, gateway.commands());
        return;
      case "ui_response":
        gateway.answerDialog(cmd.requestId, cmd.answer);
        reply(cmd.id, cmd.cmd, true, { done: true });
        return;
      case "dispose":
        gateway.dispose();
        reply(cmd.id, cmd.cmd, true, { done: true });
        return;
    }
  } catch (err) {
    reply(cmd.id, cmd.cmd, false, undefined, errText(err));
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const rl = readline.createInterface({ input: process.stdin });
// Commands run serially (session swaps must not interleave), but prompt only
// occupies the queue until the run is started — see handle("prompt").
let chain: Promise<void> = Promise.resolve();
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let cmd: ClientCommand;
  try {
    cmd = JSON.parse(trimmed) as ClientCommand;
  } catch {
    reply(-1, undefined, false, undefined, "invalid JSON on stdin");
    return;
  }
  if (!KNOWN.has(cmd.cmd)) {
    reply(cmd.id, undefined, false, undefined, `unknown command: ${String(cmd.cmd)}`);
    return;
  }
  // Abort/approve/mode jump the queue: they must work while anything else is pending.
  // Read-only status queries also skip it so a slow session swap can't stall the UI's polling.
  // ui_response too: an extension command waiting on a dialog holds the queue until it is answered.
  if (["abort", "approve", "ui_response", "mode_set", "router_status", "git_changes", "files_list", "notify"].includes(cmd.cmd)) {
    void handle(cmd);
    return;
  }
  chain = chain.then(() => handle(cmd));
});

rl.on("close", () => {
  gateway.dispose();
  // No process.exit(): let pending stdout writes flush and the process end naturally.
});
