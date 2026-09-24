/**
 * Handoff: instead of compacting (lossy, same session), the model writes a
 * self-contained prompt for a fresh session. Same idea as pi's
 * examples/extensions/handoff.ts, done by the sidecar so the GUI can show it.
 */
export const HANDOFF_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, write the first prompt of a new thread that:

1. Summarizes what matters from the conversation: the goal, decisions made and why, approaches that failed, key findings
2. States the current state: what is done, what is not, relevant files that were discussed or modified (with paths)
3. Lists pitfalls the next thread must not repeat
4. Clearly states the next task based on the user's goal
5. Is self-contained: the new thread has no access to the old conversation

Write all of it, headings included, in the language the user writes in (the headings below are only an example). Be concise but keep every fact the next thread needs.
Output only the prompt itself, with no preamble like "Here's the prompt".

Example format:
## Context
We've been working on X. Key decisions:
- Decision 1

Files involved:
- path/to/file.ts

## Pitfalls
- ...

## Task
[Clear description of what to do next]`;

export const DEFAULT_GOAL = "Continue the work exactly where the conversation left off.";

/** A session entry (SessionEntry) seen only through the fields used here. */
type Entry = { type: string; id: string } & Record<string, unknown>;

/** Messages the model actually sees on this branch: after a compaction, its summary + kept entries onwards. */
export function handoffMessages(branch: Entry[]): unknown[] {
  let at = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i].type === "compaction") {
      at = i;
      break;
    }
  }
  let entries = branch;
  if (at >= 0) {
    const kept = branch.findIndex((e) => e.id === branch[at].firstKeptEntryId);
    entries = [branch[at], ...(kept >= 0 ? branch.slice(kept, at) : []), ...branch.slice(at + 1)];
  }
  const out: unknown[] = [];
  for (const e of entries) {
    if (e.type === "message") out.push(e.message);
    else if (e.type === "compaction")
      out.push({
        role: "compactionSummary",
        summary: e.summary,
        tokensBefore: e.tokensBefore,
        timestamp: new Date(e.timestamp as string).getTime(),
      });
  }
  return out;
}

export function handoffUserText(conversation: string, goal: string): string {
  return `## Conversation History\n\n${conversation}\n\n## User's Goal for New Thread\n\n${goal.trim() || DEFAULT_GOAL}`;
}
