/**
 * Bash commands as the shell splits them — shared by the permission gate (sidecar) and the
 * approval card (UI), so the prefix the card offers is the one the gate remembers.
 */

/** Leading `VAR=value` that only changes formatting. LD_PRELOAD=, GIT_EXTERNAL_DIFF=, PAGER=… run code. */
export const SAFE_VAR = /^(LANG|LANGUAGE|LC_[A-Z]+|TZ|COLUMNS|LINES|NO_COLOR|FORCE_COLOR|CLICOLOR(_FORCE)?|TERM)=/;

export interface Segment {
  /** Words with quotes and escapes removed, redirections taken out. */
  words: string[];
  /** Output goes to a file (`>`, `>>`, `&>`, `<>`), /dev/null and fd duplication excepted. */
  writes: boolean;
}

/**
 * Split a bash command the way the shell would, far enough to judge it: segments at unquoted
 * `;` `&` `|` `&&` `||` and newlines, words unquoted. null = something we will not reason about
 * (command or process substitution, subshells, unbalanced quotes). Errs towards more segments:
 * `#` comments are not recognised, so their text is judged as commands too.
 */
export function parseCommand(s: string): Segment[] | null {
  const segs: Segment[] = [];
  let words: string[] = [];
  let word: string | null = null;
  let writes = false;
  let dropNext = false; // the next word is a redirection target, not an argument
  const endWord = () => {
    if (word === null) return;
    if (dropNext) dropNext = false;
    else words.push(word);
    word = null;
  };
  const endSeg = () => {
    endWord();
    if (words.length || writes) segs.push({ words, writes });
    words = [];
    writes = false;
    dropNext = false;
  };
  /** `2>`: the digits before a redirection are its fd, not a word. */
  const takeFd = () => {
    if (word !== null && /^\d*$/.test(word)) word = null;
    else endWord();
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      if (s[i + 1] !== "\n") word = (word ?? "") + (s[i + 1] ?? "");
      i++;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      word = (word ?? "") + s.slice(i + 1, end);
      i = end;
    } else if (c === "$" && s[i + 1] === "'") {
      // $'…' — backslash escapes, including \'
      let j = i + 2;
      let v = "";
      for (; j < s.length && s[j] !== "'"; j++) {
        if (s[j] === "\\") j++;
        v += s[j] ?? "";
      }
      if (j >= s.length) return null;
      word = (word ?? "") + v;
      i = j;
    } else if (c === "`" || (c === "$" && s[i + 1] === "(") || c === "(" || c === ")") {
      return null;
    } else if (c === '"') {
      let j = i + 1;
      let v = "";
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === "`" || (s[j] === "$" && s[j + 1] === "(")) return null;
        if (s[j] === "\\" && '$`"\\\n'.includes(s[j + 1] ?? "")) {
          j++;
          if (s[j] === "\n") continue;
        }
        v += s[j];
      }
      if (j >= s.length) return null;
      word = (word ?? "") + v;
      i = j;
    } else if (c === " " || c === "\t") {
      endWord();
    } else if (c === ">" || (c === "&" && s[i + 1] === ">")) {
      if (c === "&") i++;
      takeFd();
      let j = i + 1;
      if (s[j] === ">" || s[j] === "|") j++;
      if (s[j] === "(") return null; // >(…)
      const dup = /^&(\d+|-)/.exec(s.slice(j)); // 2>&1, >&-
      const devNull = /^\s*\/dev\/null(?=[\s;&|]|$)/.exec(s.slice(j));
      if (dup) i = j + dup[0].length - 1;
      else if (devNull) i = j + devNull[0].length - 1;
      else {
        writes = true;
        i = j - 1;
      }
    } else if (c === "<") {
      if (s[i + 1] === "(") return null; // <(…)
      takeFd();
      if (s[i + 1] === ">") writes = true; // <> opens for writing
      while (s[i + 1] === "<" || s[i + 1] === ">" || s[i + 1] === "&") i++;
      dropNext = true;
    } else if (c === ";" || c === "&" || c === "|" || c === "\n") {
      endSeg();
    } else {
      word = (word ?? "") + c;
    }
  }
  endSeg();
  return segs;
}


/** Programs whose first argument is a subcommand worth keeping: "pnpm test", "git commit". */
const SUBCOMMANDS = new Set([
  "git", "npm", "pnpm", "yarn", "bun", "cargo", "go", "docker", "podman", "kubectl", "make", "just",
  "uv", "pip", "pip3", "poetry", "deno", "dotnet", "gradle", "mvn", "systemctl", "tauri", "gh", "flatpak",
]);
/** …and their "run this other program" subcommands: "pnpm exec vitest", "npm run build". */
const RUNNERS = new Set(["exec", "dlx", "run", "x"]);
/** Interpreters: the script is part of the prefix; inline code (-c/-e) is never remembered. */
const INTERPRETERS = new Set(["python", "python3", "node", "bash", "sh", "zsh", "fish", "ruby", "perl", "tsx", "ts-node", "npx", "bunx", "uvx"]);

/** The prefix one segment would be remembered by, or null when it cannot be (inline code, odd env). */
export function segmentPrefix(words: string[]): string | null {
  let k = 0;
  for (; k < words.length && /^[A-Za-z_]\w*=/.test(words[k]); k++) if (!SAFE_VAR.test(words[k])) return null;
  const w = words.slice(k);
  if (!w.length) return null;
  const [first, second, third] = w;
  if (INTERPRETERS.has(first)) return second && !second.startsWith("-") ? `${first} ${second}` : null;
  if (SUBCOMMANDS.has(first) && second && !second.startsWith("-")) {
    return RUNNERS.has(second) && third && !third.startsWith("-") ? `${first} ${second} ${third}` : `${first} ${second}`;
  }
  return first;
}

/**
 * "Always in this session" for bash: one prefix per segment of the command ("cd x && pnpm test" →
 * ["cd", "pnpm test"]). null = this command cannot be remembered (substitutions, inline code).
 */
export function bashPrefixes(command: string): string[] | null {
  const segs = parseCommand(command);
  if (!segs?.length) return null;
  const out: string[] = [];
  for (const s of segs) {
    const p = segmentPrefix(s.words);
    if (p === null) return null;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** Every segment starts with a remembered prefix, word for word, and none writes to a file. */
export function coveredByPrefixes(command: string, prefixes: ReadonlySet<string>): boolean {
  if (!prefixes.size) return false;
  const segs = parseCommand(command);
  if (!segs?.length) return false;
  return segs.every((s) => {
    if (s.writes) return false;
    const p = segmentPrefix(s.words);
    return p !== null && prefixes.has(p);
  });
}
