import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isCheckCommand } from "./constitution.js";

/**
 * Loops without progress — the ones the identical-call guard can't see, because every
 * call is a little different:
 *  - a file edited back to a state it already had in this run (A → B → A),
 *  - the same check failing the same way again and again with edits in between.
 * The model gets a note on the tool result itself, where it is looking right now.
 */

const SAME_FAILURE = 3;

/** Failure output with the noise (times, addresses, temp paths, counters) taken out. */
function failureKey(command: string, output: string): string {
  const core = output
    .replace(/\b\d+(\.\d+)?\s*(ms|s|sec)\b/g, "#")
    .replace(/0x[0-9a-f]+/gi, "#")
    .replace(/\/tmp\/[^\s:'"]+/g, "#")
    .replace(/\d+/g, "#")
    .slice(-2000);
  return createHash("sha1").update(`${command}\n${core}`).digest("hex");
}

export class ProgressWatch {
  /** Per file: hashes of the states it has been in this run, in order. */
  private states = new Map<string, string[]>();
  private failKey: string | null = null;
  private failCount = 0;
  private editedSinceFail = false;

  constructor(private readonly cwd: () => string) {}

  startRun(): void {
    this.states.clear();
    this.failKey = null;
    this.failCount = 0;
    this.editedSinceFail = false;
  }

  private abs(p: string): string {
    const clean = p.startsWith("@") ? p.slice(1) : p;
    return isAbsolute(clean) ? resolve(clean) : resolve(this.cwd(), clean);
  }

  /** Remember a file's state before the model's first change to it. */
  beforeTool(toolName: string, input: Record<string, unknown>): void {
    if (toolName !== "edit" && toolName !== "write") return;
    const path = typeof input.path === "string" ? this.abs(input.path) : null;
    if (!path || this.states.has(path) || !existsSync(path)) return;
    this.states.set(path, [hashFile(path)]);
  }

  /** A note to append to this tool result, or null. */
  afterTool(toolName: string, input: Record<string, unknown>, isError: boolean, output: string): string | null {
    if ((toolName === "edit" || toolName === "write") && !isError && typeof input.path === "string") {
      this.editedSinceFail = true;
      const path = this.abs(input.path);
      if (!existsSync(path)) return null;
      const h = hashFile(path);
      const seen = this.states.get(path) ?? [];
      const back = seen.slice(0, -1).lastIndexOf(h);
      seen.push(h);
      this.states.set(path, seen);
      if (back >= 0) {
        const steps = seen.length - 1 - back;
        return (
          `[Progress check] ${input.path} is now exactly as it was ${steps} change(s) ago — this edit undid earlier work. ` +
          "You are going in circles. Stop editing, state in one sentence what you actually know about the problem, then pick a different approach (read the error again, add a print, check your assumption)."
        );
      }
      return null;
    }
    if (toolName === "bash" && typeof input.command === "string" && isCheckCommand(input.command)) {
      if (!isError) {
        this.failKey = null;
        this.failCount = 0;
        return null;
      }
      const key = failureKey(input.command, output);
      if (key === this.failKey && this.editedSinceFail) this.failCount++;
      else if (key !== this.failKey) {
        this.failKey = key;
        this.failCount = 1;
      }
      this.editedSinceFail = false;
      if (this.failCount === SAME_FAILURE) {
        return (
          `[Progress check] This check has now failed the same way ${SAME_FAILURE} times, with changes in between — the changes are not reaching the cause. ` +
          "Do not make another similar change. Re-read the failure from the top, find the first line that is wrong, and verify your assumption about the cause directly (print the value, read the code it calls) before editing again."
        );
      }
    }
    return null;
  }
}

function hashFile(path: string): string {
  try {
    return createHash("sha1").update(readFileSync(path)).digest("hex");
  } catch {
    return "";
  }
}
