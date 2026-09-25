import type { PermissionMode } from "../../shared/protocol.js";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Tools that only look at things. Allowed in every mode, never prompt. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "glob", "web_search", "fetch_content", "source_check"]);
const EDIT_TOOLS = new Set(["edit", "write"]);

/**
 * BrowserOS (MCP direct tools, ~/.pi/agent/mcp.json) is a browser set up for agents only — the
 * user said to let the model do whatever it wants there. Every browseros_* call is free.
 */
function isReadOnlyTool(toolName: string, input: Record<string, unknown>): boolean {
  if (READ_ONLY_TOOLS.has(toolName) || toolName.startsWith("browseros_")) return true;
  // The MCP proxy's own look-ups: search, describe, status, instructions, connect.
  return toolName === "mcp" && !input.tool && !input.action;
}

const DESTRUCTIVE = [
  /\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|chgrp|ln|tee|truncate|dd|shred|kill|pkill|killall|reboot|shutdown|sudo|su)\b/i,
  />/, // any redirect left after the harmless ones are stripped writes a file
  /\b(npm|pnpm|yarn|bun)\s+(add|remove|install|uninstall|update|ci|link|publish)\b/i,
  /\bpip3?\s+(install|uninstall)\b/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|clean|stash|cherry-pick|revert|tag|init|clone)\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,
  /\bsed\s+(-[a-z]*i|--in-place)/i,
  /\s-(delete|exec|execdir|ok|fprint)\b/, // find side effects
];

const SAFE_START = [
  /^(cat|head|tail|less|more|grep|rg|fd|find|ls|eza|tree|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|which|whereis|type|env|printenv|uname|whoami|id|date|uptime|ps|free|jq|awk|bat|basename|dirname|realpath|nvidia-smi|od|xxd|hexdump|cut|tr|nl|column|md5sum|sha256sum|cmp)\b/,
  /^sed\s+-n\b/,
  /^git\s+(status|log|diff|show|branch|remote|blame|ls-files|ls-tree|rev-parse|describe)\b/,
  /^(npm|pnpm|yarn)\s+(list|ls|view|info|why|outdated|audit)\b/,
  /^(node|python3?|cargo|rustc|go|pnpm|npm)\s+(--version|-V)\b/,
];

/** A bash command is read-only when every segment of every pipe/chain is. */
export function isReadOnlyCommand(command: string): boolean {
  if (/[`]|\$\(/.test(command)) return false; // command substitution can run anything
  const segments = command.split(/\|\||&&|;|\||\n/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((seg) => {
    const cmd = seg
      .replace(/^(\w+=\S*\s+)+/, "") // leading VAR=value
      .replace(/\d?>&\d|\d?>\s*\/dev\/null/g, ""); // 2>&1, 2>/dev/null, >/dev/null
    return !DESTRUCTIVE.some((p) => p.test(cmd)) && SAFE_START.some((p) => p.test(cmd));
  });
}

export type Verdict = { kind: "allow" } | { kind: "ask" } | { kind: "block"; reason: string };

export function decide(mode: PermissionMode, toolName: string, input: Record<string, unknown>): Verdict {
  if (mode === "yolo") return { kind: "allow" };
  if (isReadOnlyTool(toolName, input)) return { kind: "allow" };
  const command = typeof input.command === "string" ? input.command : "";

  if (mode === "plan") {
    if (toolName === "bash" && isReadOnlyCommand(command)) return { kind: "allow" };
    return {
      kind: "block",
      reason:
        `Plan mode is active: "${toolName}" is not allowed. Only read-only tools and read-only shell ` +
        `commands may run. Finish the plan and let the user switch modes to execute it.`,
    };
  }

  if (toolName === "bash" && isReadOnlyCommand(command)) return { kind: "allow" };
  if (mode === "acceptEdits" && EDIT_TOOLS.has(toolName)) return { kind: "allow" };
  return { kind: "ask" };
}

export const PLAN_PROMPT = `[PLAN MODE]
The user enabled plan mode in the GUI. You may only explore: read files, search, and run read-only shell commands.
Do not edit, write or run commands that change anything — those calls will be blocked.
Investigate what is needed, then answer with a concrete, numbered implementation plan
(files to change and what changes). The user will review it and switch modes to execute it.`;

/** Marker in the environment of everything Pi Code starts (children inherit it, even when detached). */
export const OWNER_ENV = "PI_GUI_OWNER";

/** The process was started by this sidecar (one of its bash calls or their descendants). */
export function startedByApp(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(`${OWNER_ENV}=${process.pid}`);
  } catch {
    return false; // gone, or not ours to read
  }
}

const NAME_KILLERS = /\b(pkill|killall|killall5|xkill|skill|slay)\b/;

/**
 * Why a bash command must be approved by the user because it signals processes this app did
 * not start, or null. The mode does not matter (yolo included): a model once killed the user's
 * Godot editor as a "stale instance", and `pkill -f` has killed its own shell.
 * pkill/killall/fuser -k match by name, so they always count. kill counts unless every target
 * is `$!`, a job (`%1`), a variable holding `$!` or a PID `isOwn` recognises.
 */
export function foreignKill(command: string, isOwn: (pid: number) => boolean): string | null {
  const flat = command.replace(/\d?>&\d/g, " ").replace(/['"]/g, " ");
  const byName = flat.match(NAME_KILLERS);
  if (byName) return `${byName[1]} matches processes by name`;
  if (/\bfuser\b[^;&|\n]*\s-[a-z]*k/.test(flat)) return "fuser -k kills whatever holds the file";
  const substituted = /\$\(|`/.test(command);
  const ownVars = /\$!/.test(command) && !substituted;
  for (const segment of flat.split(/[;&|\n]+/)) {
    const words = segment.trim().split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      if (words[i] !== "kill" && !words[i].endsWith("/kill")) continue;
      const viaXargs = words.slice(0, i).includes("xargs");
      const targets: string[] = [];
      let listing = false;
      let options = true;
      let signal = false;
      for (let j = i + 1; j < words.length; j++) {
        const w = words[j];
        if (options && w === "--") options = false;
        else if (options && ["-l", "-L", "--list", "--table"].includes(w)) listing = true;
        else if (options && ["-s", "-n", "--signal"].includes(w)) (j++, (signal = true));
        else if (options && !signal && /^-\w+$/.test(w)) signal = true; // -9, -KILL, -SIGTERM
        else targets.push(w); // a second "-1" is a process group (kill -9 -1 = everything)
      }
      if (listing) continue;
      if (viaXargs) return "kill gets its PIDs from another command";
      for (const t of targets) {
        if (t === "$!" || t.startsWith("%")) continue;
        if (/^\$\{?\w+\}?$/.test(t)) {
          if (ownVars) continue;
          return `kill ${t}: the variable does not come from $! in this command`;
        }
        if (t.startsWith("$(") || t.startsWith("`")) return "kill gets its PIDs from another command";
        if (/^-\d+$/.test(t)) return `kill ${t} signals a whole process group`;
        if (/^\d+$/.test(t)) {
          if (!isOwn(Number(t))) return `PID ${t} was not started by Pi Code`;
        }
      }
    }
  }
  return null;
}

export type ToolCall = { name: string; args: Record<string, unknown>; /** "always allow" key */ key: string };

/**
 * pi-mcp-adapter's proxy tool `mcp` hides the real tool in its arguments (`{tool, args}`, args a
 * JSON string or object). Permissions look at the real call, and "always allow" remembers the real
 * tool — allowing `mcp` for a snapshot must not allow every browser click that follows.
 */
export function unwrapMcp(toolName: string, input: Record<string, unknown>): ToolCall {
  if (toolName !== "mcp" || typeof input.tool !== "string" || !input.tool) return { name: toolName, args: input, key: toolName };
  let args: Record<string, unknown> = {};
  if (typeof input.args === "string") {
    try {
      const parsed = JSON.parse(input.args) as unknown;
      if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
    } catch {
      /* the adapter rejects it too */
    }
  } else if (input.args && typeof input.args === "object") args = input.args as Record<string, unknown>;
  return { name: input.tool, args, key: `mcp:${input.tool}` };
}

const HOME = process.env.HOME ?? "/home";

const RISKY_BASH: [RegExp, string][] = [
  [/\b(sudo|pkexec|doas|su)\b/, "runs as root"],
  [/\b(pacman|yay|paru|pamac)\s+-[A-Za-z]*[SRU]|\b(apt|apt-get|dnf|zypper)\s+(install|remove|purge)\b|\bflatpak\s+(install|uninstall|remote-add)\b|\bsnap\s+(install|remove)\b/, "installs or removes system packages"],
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall)\b[^;&|\n]*\s(-g|--global)\b|\bpipx\s+install\b|\bpip3?\s+install\b[^;&|\n]*(--user|--break-system-packages)|\b(cargo|go)\s+install\b|\buv\s+tool\s+install\b/, "installs a program for the whole user account"],
  [/\bsystemctl\b[^;&|\n]*\b(enable|disable|start|stop|restart|mask|unmask|daemon-reload|edit)\b|\bcrontab\b|\b(gsettings|dconf)\s+(set|write|reset)|\bkwriteconfig\d*\b|\bxdg-(settings|mime)\s+(set|default)\b|\b(chsh|usermod|passwd|ufw|firewall-cmd|iptables|nft)\b/, "changes system or desktop settings"],
  [/\bcurl\b[^;&|\n]*\s(-[a-zA-Z]*[oO]\b|--output|--remote-name)|\bwget\b(?![^;&|\n]*\s(-q?O\s*-|--output-document=?-)(\s|$))|\b(aria2c|yt-dlp|youtube-dl)\b|\bgit\s+clone\b/, "downloads files from the internet"],
  [/\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b|\b(curl|wget)\b[^\n]*\|\s*python/, "runs a script straight from the internet"],
  [/\bcurl\b[^;&|\n]*\s(-X\s*(POST|PUT|PATCH|DELETE)|-d\b|--data|-F\b|--form|-T\b|--upload-file)/i, "sends data to a server"],
  [/\b(ssh|scp|sftp|rsync)\b[^;&|\n]*\S+@?\S*:/, "connects to another machine"],
  [/\bgit\s+push\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f|\bgit\s+branch\s+-D\b|\bgit\s+stash\s+(drop|clear)\b|\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)|\bgit\s+filter-(branch|repo)\b/, "publishes or throws away git history/changes"],
  [/\brm\s+(-[a-zA-Z]*[rR]|--recursive)|\bfind\b[^;&|\n]*\s-delete\b|\bshred\b|\bdd\b[^;&|\n]*\bof=/, "deletes recursively or overwrites a device/file"],
];

/** A home dotfile/dotdir (~/.config, ~/.ssh, ~/.bashrc…) or a system path. */
function configPath(p: string): boolean {
  return new RegExp(`^(${HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.|/etc/|/usr/|/boot/|/var/)`).test(p);
}

/** Configuration the user lives with: home dotfiles/dotdirs and /etc. */
function userConfigPath(p: string): boolean {
  return p.startsWith(`${HOME}/.`) || p.startsWith("/etc/");
}

const WRITE_OP = /(^|[^0-9&<])>{1,2}(?!&)|\b(tee|cp|mv|ln|mkdir|touch|rm|rmdir|chmod|chown|install|unzip|truncate)\b|\bsed\s+(-[a-z]*i|--in-place)|\btar\s+[^;&|\n]*x/;

function resolvePath(p: string, cwd: string): string {
  const clean = p.startsWith("@") ? p.slice(1) : p;
  const home = clean.replace(/^~(?=\/|$)/, HOME);
  return isAbsolute(home) ? resolve(home) : resolve(cwd, home);
}

/**
 * Actions the model must not take on its own, whatever the mode ("always allow" and yolo
 * included — like foreignKill): changing the system, downloading or running things from the
 * internet, publishing or destroying work, writing outside the project. One session: the model
 * curl-ed an extension into ~/.browseros without a word. BrowserOS itself is the agents' own
 * browser and is not policed here. Returns why, or null.
 */
export function riskyAction(call: ToolCall, cwd: string): string | null {
  const { name, args } = call;
  if (name === "bash" && typeof args.command === "string") {
    const command = args.command;
    for (const [re, why] of RISKY_BASH) if (re.test(command)) return why;
    // Writing next to a config path: running /usr/bin/python3 or reading ~/.config is fine.
    if (!isReadOnlyCommand(command) && WRITE_OP.test(command)) {
      const paths = command.match(/(~|\$HOME|\/)[^\s'";&|<>()]*/g) ?? [];
      const hit = paths.map((p) => p.replace(/^\$HOME/, HOME)).find((p) => userConfigPath(resolvePath(p, cwd)));
      if (hit) return `changes files in ${hit}`;
    }
    return null;
  }
  if ((name === "edit" || name === "write") && typeof (args.path ?? args.file_path) === "string") {
    const p = resolvePath(String(args.path ?? args.file_path), cwd);
    if (configPath(p)) return `writes ${p} (configuration outside the project)`;
    const inside = p === cwd || p.startsWith(`${cwd}/`);
    if (!inside && !p.startsWith("/tmp/")) return `writes ${p}, outside the project`;
    return null;
  }
  if (name === "mcp" && typeof args.action === "string" && /^(install|auth)/.test(args.action))
    return `changes the MCP configuration (${args.action})`;
  return null;
}
