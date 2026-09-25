import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The repo this sidecar runs from, when it is a checkout (not inside a packaged app). */
function sourceDir(): string | null {
  const dir = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
  return existsSync(`${dir}/.git`) ? dir : null;
}

/**
 * What a model can't know about where it runs. Without it a model drew a fake terminal for
 * an ad instead of using the real GUI, ran on after "make a plan", reverted with git and
 * mixed up states, and wrote hand-over prompts by hand.
 */
export function appContext(src = sourceDir()): string {
  return [
    "[Pi Code]",
    "You run inside Pi Code, a desktop GUI (Tauri) for pi: the user sees your text, tool calls and approvals in its window, not in a terminal." +
      (src ? ` Its sources are in ${src} — when the user talks about "this app" or "Pi Code", that is what they mean.` : ""),
    "- The user wants short steps: after each meaningful step write 1–2 sentences of status before going on.",
    "- When the user asks for a plan, show the plan and end your turn. Start the work only after they accept it.",
    "- Undoing changes: Pi Code keeps a checkpoint per prompt (\"Undo file changes\" in the GUI). Prefer it over git reset/checkout; before any revert say which state you will go back to and wait for a yes.",
    "- A new session with a summary: tell the user to use /handoff (also a button by the context ring) instead of writing the prompt yourself.",
    "- Never kill processes you did not start in this session (the user's editors, servers, other sessions).",
  ].join("\n");
}
