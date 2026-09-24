import type { PermissionMode } from "../../shared/protocol.js";

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
