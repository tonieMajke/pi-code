import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The file exists but is not a JSON object. It is left alone; a copy sits at `backup`. */
export class BrokenJsonError extends Error {
  constructor(
    readonly file: string,
    readonly backup: string,
    cause: string,
  ) {
    super(`${file} nie jest poprawnym JSON-em (${cause}). Ustawienia nie są zapisywane; kopia: ${backup}. Popraw albo usuń ten plik i uruchom Pi Code ponownie.`);
  }
}

/**
 * A JSON object from `file`: {} when missing. A broken file throws BrokenJsonError after copying
 * it to `<file>.bak` — writing defaults over it would drop every key the user had.
 */
export function readJsonObject(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  let cause = "to nie obiekt";
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch (e) {
    cause = e instanceof Error ? e.message : String(e);
  }
  const backup = `${file}.bak`;
  try {
    copyFileSync(file, backup);
  } catch {
    /* the error below still stops the write */
  }
  throw new BrokenJsonError(file, backup, cause);
}

/** Write through a temp file and rename: a crash mid-write never leaves half a file. */
export function writeJsonAtomic(file: string, data: unknown, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, mode === undefined ? undefined : { mode });
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, file);
}

/** Read-modify-write of a shared JSON file (pi-gui.json has several writers: config, voice). */
export function updateJsonObject(file: string, patch: (raw: Record<string, unknown>) => Record<string, unknown>): void {
  writeJsonAtomic(file, patch(readJsonObject(file)));
}
