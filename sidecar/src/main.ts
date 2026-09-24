import readline from "node:readline";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { AppearanceStore } from "./appearance.js";
import { PiGateway } from "./gateway.js";
import { t } from "../../shared/i18n.js";
import { gitChanges, gitCommit, gitRevert, gitStage, gitUnstage, listFiles, notify, routerStatus } from "./workspace.js";
import type { ClientCommand, CommandName, PiEvent, SidecarOut } from "../../shared/protocol.js";

// stdout is the JSONL protocol; keep stray logging (pi extensions, libraries) off it.
console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);

const gateway = new PiGateway();
/** "Dodaj projekt" typed in the browser build: must be an existing directory ("~" allowed). */
function checkDir(path: string): string {
  const full = resolve(path.trim().replace(/^~(?=$|\/)/, homedir()));
  if (!statSync(full, { throwIfNoEntry: false })?.isDirectory()) throw new Error(t("nie ma takiego folderu: {path}", { path: full }));
  return full;
}

const appearance = new AppearanceStore(process.env.PI_GUI_APPEARANCE_DIR ?? getAgentDir());

function out(msg: SidecarOut): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const emit = (e: PiEvent, session?: string) => out(session ? { event: e, session } : { event: e });

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
  "git_stage",
  "git_unstage",
  "git_commit",
  "git_commit_message",
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
  "session_handoff",
  "history_image",
  "sidebar_get",
  "sidebar_set",
  "session_delete",
  "dir_check",
  "lang_set",
  "memory_get",
  "memory_set",
  "memory_learn",
  "agents_set",
  "providers_list",
  "provider_key",
  "provider_logout",
  "endpoint_probe",
  "endpoint_add",
  "endpoint_remove",
  "onboarding_get",
  "onboarding_done",
  "stats_query",
  "dispose",
]);

function requireReady(): void {
  if (!gateway.ready) throw new Error("not initialized — send init first");
}

async function handle(cmd: ClientCommand): Promise<void> {
  try {
    switch (cmd.cmd) {
      case "init":
        await gateway.init(emit, cmd.cwd, cmd.lang);
        reply(cmd.id, cmd.cmd, true, { ready: true });
        return;
      case "prompt":
        requireReady();
        // prompt() resolves only when the whole run ends. Don't hold the command
        // queue for that long — abort/steer/sessions_list must get through meanwhile.
        gateway
          .prompt(cmd.text, cmd.images, cmd.behavior, cmd.session)
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
        // From the sidebar: a background session is also released from memory.
        if (cmd.session) await gateway.stopSession(cmd.session);
        else await gateway.abort();
        reply(cmd.id, cmd.cmd, true, { done: true });
        return;
      case "status":
        reply(cmd.id, cmd.cmd, true, { busy: gateway.busy, ready: gateway.ready });
        return;
      case "sessions_list":
        reply(cmd.id, cmd.cmd, true, await gateway.listSessions());
        return;
      case "session_open": {
        requireReady();
        // A working session goes to the background, unless that exceeds the local-model limit.
        const blocked = await gateway.prepareSwitch(cmd.stop);
        if (blocked) return reply(cmd.id, cmd.cmd, true, { blocked });
        await gateway.openSession(cmd.path);
        reply(cmd.id, cmd.cmd, true, { done: true });
        return;
      }
      case "session_new": {
        requireReady();
        const blocked = await gateway.prepareSwitch(cmd.stop);
        if (blocked) return reply(cmd.id, cmd.cmd, true, { blocked });
        await gateway.newSession(cmd.cwd);
        reply(cmd.id, cmd.cmd, true, { done: true });
        return;
      }
      case "session_rename":
        requireReady();
        await gateway.rename(cmd.name);
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
        await gateway.setModel(cmd.provider, cmd.modelId);
        reply(cmd.id, cmd.cmd, true, { done: true });
        return;
      case "rewind":
        requireReady();
        reply(cmd.id, cmd.cmd, true, { text: await gateway.rewind(cmd.fromEnd) });
        return;
      case "git_changes":
        reply(cmd.id, cmd.cmd, true, await gitChanges(gateway.workingDir));
        return;
      case "git_revert":
        await gitRevert(gateway.workingDir, cmd.path);
        reply(cmd.id, cmd.cmd, true, await gitChanges(gateway.workingDir));
        return;
      case "git_stage":
        await gitStage(gateway.workingDir, cmd.paths);
        reply(cmd.id, cmd.cmd, true, await gitChanges(gateway.workingDir));
        return;
      case "git_unstage":
        await gitUnstage(gateway.workingDir, cmd.paths);
        reply(cmd.id, cmd.cmd, true, await gitChanges(gateway.workingDir));
        return;
      case "git_commit": {
        const done = await gitCommit(gateway.workingDir, cmd.message);
        reply(cmd.id, cmd.cmd, true, { ...done, changes: await gitChanges(gateway.workingDir) });
        return;
      }
      case "git_commit_message":
        requireReady();
        // A model call: seconds, maybe queued behind a busy slot — don't hold the command queue.
        gateway
          .commitMessage()
          .then((message) => reply(cmd.id, cmd.cmd, true, { message }))
          .catch((err) => reply(cmd.id, cmd.cmd, false, undefined, errText(err)));
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
        reply(cmd.id, cmd.cmd, true, await gateway.updateSettings(cmd.patch));
        return;
      case "compact":
        requireReady();
        await gateway.compact(cmd.instructions);
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
        reply(cmd.id, cmd.cmd, true, { text: await gateway.fork(cmd.entryId) });
        return;
      case "session_clone":
        requireReady();
        await gateway.clone();
        reply(cmd.id, cmd.cmd, true, { done: true });
        return;
      case "sidebar_get":
        requireReady();
        reply(cmd.id, cmd.cmd, true, gateway.sidebar.get());
        return;
      case "sidebar_set":
        requireReady();
        reply(cmd.id, cmd.cmd, true, gateway.sidebar.set(cmd.state));
        return;
      case "session_delete":
        requireReady();
        reply(cmd.id, cmd.cmd, true, await gateway.deleteSession(cmd.path));
        return;
      case "dir_check":
        reply(cmd.id, cmd.cmd, true, { path: checkDir(cmd.path) });
        return;
      case "history_image":
        requireReady();
        reply(cmd.id, cmd.cmd, true, gateway.historyImage(cmd.ref));
        return;
      case "session_handoff":
        requireReady();
        reply(cmd.id, cmd.cmd, true, await gateway.handoff(cmd.goal ?? ""));
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
        await gateway.reload();
        reply(cmd.id, cmd.cmd, true, gateway.commands());
        return;
      case "ui_response":
        gateway.answerDialog(cmd.requestId, cmd.answer);
        reply(cmd.id, cmd.cmd, true, { done: true });
        return;
      case "lang_set":
        gateway.setLanguage(cmd.lang);
        reply(cmd.id, cmd.cmd, true, { lang: cmd.lang });
        return;
      case "memory_get":
        requireReady();
        reply(cmd.id, cmd.cmd, true, gateway.memoryState());
        return;
      case "memory_set":
        requireReady();
        reply(cmd.id, cmd.cmd, true, gateway.setMemory(cmd.entries));
        return;
      case "memory_learn":
        requireReady();
        reply(cmd.id, cmd.cmd, true, { added: await gateway.learnNow() });
        return;
      case "agents_set":
        requireReady();
        reply(cmd.id, cmd.cmd, true, gateway.setAgents(cmd.scope, cmd.text));
        return;
      case "providers_list":
        requireReady();
        reply(cmd.id, cmd.cmd, true, await gateway.providers());
        return;
      case "provider_key":
        requireReady();
        reply(cmd.id, cmd.cmd, true, await gateway.providerKey(cmd.provider, cmd.key));
        return;
      case "provider_logout":
        requireReady();
        reply(cmd.id, cmd.cmd, true, await gateway.providerLogout(cmd.provider));
        return;
      case "endpoint_probe":
        requireReady();
        reply(cmd.id, cmd.cmd, true, await gateway.probeEndpoint(cmd.baseUrl, cmd.apiKey));
        return;
      case "endpoint_add":
        requireReady();
        reply(cmd.id, cmd.cmd, true, await gateway.addEndpoint(cmd.endpoint));
        return;
      case "endpoint_remove":
        requireReady();
        reply(cmd.id, cmd.cmd, true, await gateway.removeEndpoint(cmd.name));
        return;
      case "onboarding_get":
        requireReady();
        reply(cmd.id, cmd.cmd, true, await gateway.onboarding());
        return;
      case "onboarding_done":
        requireReady();
        gateway.finishOnboarding();
        reply(cmd.id, cmd.cmd, true, { done: true });
        return;
      case "stats_query":
        requireReady();
        reply(cmd.id, cmd.cmd, true, gateway.statsQuery(cmd.range));
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
    // Echo the name back: the UI clears its own waiting state (e.g. busy) by it.
    reply(cmd.id, cmd.cmd, false, undefined, `unknown command: ${String(cmd.cmd)}`);
    return;
  }
  // Abort/approve/mode jump the queue: they must work while anything else is pending.
  // Read-only status queries also skip it so a slow session swap can't stall the UI's polling.
  // ui_response too: an extension command waiting on a dialog holds the queue until it is answered.
  if (["abort", "approve", "ui_response", "mode_set", "router_status", "git_changes", "files_list", "notify", "history_image", "endpoint_probe", "lang_set"].includes(cmd.cmd)) {
    void handle(cmd);
    return;
  }
  chain = chain.then(() => handle(cmd));
});

rl.on("close", () => {
  gateway.dispose();
  // No process.exit(): let pending stdout writes flush and the process end naturally.
});
