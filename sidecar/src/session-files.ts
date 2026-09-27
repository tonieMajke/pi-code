import { readFileSync } from "node:fs";
import { parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * PI_GUI_EPHEMERAL (eval harness, e2e, verification stacks): nothing is written to the user's
 * session history. Every place that makes a SessionManager goes through here — init alone used
 * to honour it, while new chats, fork/clone, handoff and opened files wrote real sessions.
 */
export function ephemeral(): boolean {
  return !!process.env.PI_GUI_EPHEMERAL;
}

/** A new session in `cwd` (optionally in a given session dir). */
export function createSession(cwd: string, sessionDir?: string): SessionManager {
  return ephemeral() ? SessionManager.inMemory(cwd) : SessionManager.create(cwd, sessionDir);
}

/** An existing session file. Ephemeral: its entries in memory; new messages never reach the file. */
export function openSessionFile(path: string, sessionDir?: string): SessionManager {
  if (!ephemeral()) return SessionManager.open(path, sessionDir);
  const entries = parseSessionEntries(readFileSync(path, "utf8"));
  const header = entries.find((e) => e.type === "session") as { cwd?: string } | undefined;
  return SessionManager.inMemory(header?.cwd || process.cwd(), undefined, entries);
}
