import { readFileSync } from "node:fs";

// Zadania: { id, title, done, due: "YYYY-MM-DD" | null, tags: string[] }
export function load(file) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return raw.map((t, i) => ({ id: t.id ?? i + 1, title: t.title, done: !!t.done, due: t.due ?? null, tags: t.tags ?? [] }));
}
