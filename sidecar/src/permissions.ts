import type { PermissionMode } from "../../shared/protocol.js";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseCommand, SAFE_VAR, type Segment } from "../../shared/shell.js";

export { parseCommand, type Segment };

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
  /\b(npm|pnpm|yarn|bun)\s+(add|remove|install|uninstall|update|ci|link|publish)\b/i,
  /\bpip3?\s+(install|uninstall)\b/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|clean|stash|cherry-pick|revert|tag|init|clone)\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,
  /\bsed\s+(-[a-z]*i|--in-place)/i,
  /\s-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)\b/, // find side effects
];

const SAFE_START = [
  /^(cat|head|tail|less|more|grep|rg|fd|find|ls|eza|tree|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|which|whereis|type|env|printenv|uname|whoami|id|date|uptime|ps|free|jq|awk|bat|basename|dirname|realpath|nvidia-smi|od|xxd|hexdump|cut|tr|nl|column|md5sum|sha256sum|cmp)(?=\s|$)/,
  /^sed\s+-n(?=\s|$)/,
  /^git\s+(status|log|diff|show|branch|remote|blame|ls-files|ls-tree|rev-parse|describe)(?=\s|$)/,
  /^(npm|pnpm|yarn)\s+(list|ls|view|info|why|outdated|audit)(?=\s|$)/,
  /^(node|python3?|cargo|rustc|go|pnpm|npm)\s+(--version|-V)$/,
];

/** `-o`, `-no` — a short-option cluster containing one of `letters`. */
const shortOpt = (args: string[], letters: RegExp) => args.some((a) => /^-[^-]/.test(a) && letters.test(a.slice(1)));
/** `--output`, `--out=x` — GNU getopt and git accept unambiguous abbreviations. */
const longOpt = (args: string[], ...names: string[]) =>
  args.some((a) => {
    if (!a.startsWith("--") || a === "--") return false;
    const n = a.slice(2).split("=")[0];
    return names.some((full) => full.startsWith(n));
  });
/** Operands, skipping options and the values of `valued` options given as a separate word. */
function operands(args: string[], valued: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") return [...out, ...args.slice(i + 1)];
    if (valued.includes(args[i])) i++;
    else if (!args[i].startsWith("-") || args[i] === "-") out.push(args[i]);
  }
  return out;
}

/** sed script without `w`/`W` (write), `e` (execute) or the `w`/`e` flags of `s`. */
function sedScriptSafe(s: string): boolean {
  let i = 0;
  const skipParts = (n: number): boolean => {
    const d = s[i++];
    if (!d || d === "\\" || d === "\n") return false;
    for (let k = 0; k < n; k++) {
      while (i < s.length && s[i] !== d) i += s[i] === "\\" ? 2 : 1;
      if (i >= s.length) return false;
      i++;
    }
    return true;
  };
  const skipTo = (end: RegExp) => {
    while (i < s.length && !end.test(s[i])) i++;
  };
  while (i < s.length) {
    const c = s[i];
    if (/[\s;!,$0-9~+{}=pPlqQnNdDgGhHxzF]/.test(c)) i++;
    else if (c === "/") {
      if (!skipParts(1)) return false;
      while (/[IM]/.test(s[i] ?? "")) i++;
    } else if (c === "\\") {
      i++;
      if (!skipParts(1)) return false;
    } else if (c === "s") {
      i++;
      if (!skipParts(2)) return false;
      while (i < s.length && /[gpiImM0-9]/.test(s[i])) i++; // `e` and `w` stop here and fail below
    } else if (c === "y") {
      i++;
      if (!skipParts(2)) return false;
    } else if (c === ":" || c === "b" || c === "t" || c === "T") skipTo(/[;\n]/); // label
    else if (c === "a" || c === "i" || c === "c" || c === "r" || c === "R") skipTo(/\n/); // text, or a file to print
    else return false;
  }
  return true;
}

function sedSafe(args: string[]): boolean {
  const scripts: string[] = [];
  let first: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let m: RegExpExecArray | null;
    if (a === "-e" || a === "--expression") scripts.push(args[++i] ?? "");
    else if (a.startsWith("--expression=")) scripts.push(a.slice(13));
    else if (a === "-l" || a === "--line-length") i++;
    else if (/^--(quiet|silent|regexp-extended|separate|null-data|unbuffered|posix|debug|sandbox|line-length=\d+)$/.test(a)) continue;
    else if ((m = /^-[nErszu]*(e)(.*)$/.exec(a))) scripts.push(m[2] || (args[++i] ?? ""));
    else if (/^-[nErszu]+$/.test(a)) continue;
    else if (a.startsWith("-") && a !== "-") return false; // -i, -f script, --in-place, unknown
    else first ??= a;
  }
  if (!scripts.length && first !== null) scripts.push(first);
  return scripts.length > 0 && scripts.every(sedScriptSafe);
}

/** awk with only -F/-v and a program that does not run commands or write files. */
function awkSafe(args: string[]): boolean {
  let program: string | null = null;
  for (let i = 0; i < args.length && program === null; i++) {
    const a = args[i];
    if (a === "-F" || a === "-v" || a === "--field-separator" || a === "--assign") i++;
    else if (/^-[Fv]./.test(a) || /^--(field-separator|assign)=/.test(a) || a === "--") continue;
    else if (a.startsWith("-")) return false; // -f file, -i inplace, -o/-p/-d write files, -l loads code
    else program = a;
  }
  if (program === null) return false;
  return !/\bsystem\b|@|\bprintf?\b[^;{}\n]*[>|]|\|\s*getline/.test(program);
}

const GIT_BRANCH_LIST = new Set([
  "list", "all", "remotes", "verbose", "show-current", "merged", "no-merged", "contains", "no-contains",
  "sort", "format", "points-at", "column", "no-column", "color", "no-color", "ignore-case", "abbrev", "no-abbrev", "omit-empty",
]);
const GIT_BRANCH_VALUED = ["--merged", "--no-merged", "--contains", "--no-contains", "--points-at", "--sort", "--format"];

function gitSafe(args: string[]): boolean {
  if (longOpt(args, "output")) return false; // git diff/log/show --output=<file>
  const [sub, ...rest] = args;
  if (sub === "branch") {
    // Listing only: -m/-d/-c/-f/-u or a bare name create, rename, delete or retarget branches.
    let listing = false;
    for (const a of rest) {
      if (a.startsWith("--")) {
        const n = a.slice(2).split("=")[0];
        if (!GIT_BRANCH_LIST.has(n)) return false;
        if (n === "list") listing = true;
      } else if (a.startsWith("-")) {
        if (!/^-[avrli]+$/.test(a)) return false;
        if (a.includes("l")) listing = true;
      }
    }
    return listing || operands(rest, GIT_BRANCH_VALUED).length === 0;
  }
  if (sub === "remote") {
    const r = rest.filter((a) => a !== "-v" && a !== "--verbose");
    return r.length === 0 || r[0] === "show" || r[0] === "get-url";
  }
  return true;
}

const NVIDIA_SETTERS =
  /^(-pm|-pl|-r|-ac|-rac|-lgc|-rgc|-lmc|-rmc|-c|-e|-am|-caa|-mig|-cc|--(persistence-mode|power-limit|gpu-reset|applications-clocks|reset-applications-clocks|lock-gpu-clocks|reset-gpu-clocks|lock-memory-clocks|reset-memory-clocks|compute-mode|ecc-config|accounting-mode|clear-accounted-apps|multi-instance-gpu|auto-boost-default|auto-boost-permission|cuda-clocks))(=|$)/;

/** Options that make an otherwise read-only program write files or run other programs. */
const ARG_CHECKS: Record<string, (args: string[]) => boolean> = {
  env: (a) => a.length === 0, // `env` lists the environment; `env CMD` runs CMD
  sort: (a) => !shortOpt(a, /o/) && !longOpt(a, "output", "compress-program"),
  uniq: (a) => operands(a, ["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"]).length < 2, // uniq IN OUT
  xxd: (a) => operands(a, ["-c", "-cols", "-g", "-groupsize", "-l", "-len", "-s", "-seek", "-o", "-offset", "-n", "-name", "-R"]).length < 2,
  tree: (a) => !shortOpt(a, /[oR]/), // -o file; -R with -H writes 00Tree.html into every directory
  date: (a) => !shortOpt(a, /s/) && !longOpt(a, "set"),
  fd: (a) => !shortOpt(a, /[xX]/) && !longOpt(a, "exec", "exec-batch"),
  rg: (a) => !longOpt(a, "pre"),
  less: (a) => !shortOpt(a, /[oO]/) && !longOpt(a, "log-file", "LOG-FILE"),
  bat: (a) => !longOpt(a, "pager") && a[0] !== "cache",
  file: (a) => !shortOpt(a, /C/) && !longOpt(a, "compile"),
  sed: sedSafe,
  awk: awkSafe,
  git: gitSafe,
  "nvidia-smi": (a) => !a.some((x) => NVIDIA_SETTERS.test(x)) && (a.length === 0 || a[0].startsWith("-") || ["dmon", "pmon", "topo"].includes(a[0])),
  npm: (a) => !a.includes("fix") && !longOpt(a, "fix"),
  pnpm: (a) => !a.includes("fix") && !longOpt(a, "fix"),
  yarn: (a) => !a.includes("fix") && !longOpt(a, "fix"),
};

function segmentReadOnly({ words, writes }: Segment): boolean {
  if (writes) return false;
  let k = 0;
  for (; k < words.length && /^[A-Za-z_]\w*=/.test(words[k]); k++) if (!SAFE_VAR.test(words[k])) return false;
  const argv = words.slice(k);
  if (!argv.length) return false;
  const line = argv.join(" ");
  if (DESTRUCTIVE.some((p) => p.test(line)) || !SAFE_START.some((p) => p.test(line))) return false;
  const check = ARG_CHECKS[argv[0]];
  return !check || check(argv.slice(1));
}

/** A bash command is read-only when every segment of every pipe/chain is. */
export function isReadOnlyCommand(command: string): boolean {
  const segs = parseCommand(command);
  return !!segs && segs.length > 0 && segs.every(segmentReadOnly);
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
