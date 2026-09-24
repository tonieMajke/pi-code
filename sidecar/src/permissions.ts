import type { PermissionMode } from "../../shared/protocol.js";
import { readFileSync } from "node:fs";

/** Tools that only look at things. Allowed in every mode, never prompt. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "glob", "web_search", "fetch_content", "source_check"]);
const EDIT_TOOLS = new Set(["edit", "write"]);

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
  if (READ_ONLY_TOOLS.has(toolName)) return { kind: "allow" };
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
