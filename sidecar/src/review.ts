/**
 * Fresh-context review: a second pass that sees only the task and the diff —
 * not the author's reasoning — so it isn't anchored to the same mistakes.
 */
const DIFF_MAX = 24000;

export function reviewPrompt(task: string, diff: string): string {
  const clipped = diff.length > DIFF_MAX ? `${diff.slice(0, DIFF_MAX)}\n[... diff truncated, ${diff.length - DIFF_MAX} more chars]` : diff;
  return `You are reviewing a change another engineer just made. You see only the task and the diff.

## Task
${task.trim() || "(no task text)"}

## Diff
\`\`\`diff
${clipped}
\`\`\`

Check, in this order:
1. Does the change actually do what the task asks? Anything missing or only half done?
2. Bugs: wrong logic, off-by-one, unhandled cases the task implies, broken callers, syntax/type errors.
3. Leftovers: debug prints, commented-out code, unrelated edits, placeholder/TODO code presented as done.

Only report real problems you can point to in the diff. Style preferences are not problems.
Be brief. End with exactly one of these lines:
VERDICT: OK
VERDICT: ISSUES
If ISSUES, list each problem above that line as "- <file>: <problem>".`;
}

export type ReviewVerdict = { ok: boolean; issues: string };

/** Unparseable answers count as OK — a confused reviewer must not trap the run. */
export function parseVerdict(text: string): ReviewVerdict {
  const m = /VERDICT:\s*(OK|ISSUES)/gi;
  let last: RegExpExecArray | null = null;
  for (let r = m.exec(text); r; r = m.exec(text)) last = r;
  if (!last || last[1].toUpperCase() === "OK") return { ok: true, issues: "" };
  const before = text.slice(0, last.index);
  const bullets = before
    .split("\n")
    .filter((l) => /^\s*[-*]\s+\S/.test(l))
    .join("\n")
    .trim();
  return { ok: false, issues: bullets || before.trim().slice(-2000) };
}

export function reviewNudge(issues: string): string {
  return (
    "[Constitution: independent review]\nA reviewer who saw only the task and your diff found these problems:\n" +
    `${issues}\n\n` +
    "For each point: if it is real, fix it and re-run the relevant check; if it is wrong, say briefly why. Then finish."
  );
}
