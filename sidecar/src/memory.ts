import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryEntry } from "../../shared/protocol.js";

/**
 * Persistent user memory, like Claude's: short facts about the user carried into
 * every session. Stored as hand-editable markdown — "## YYYY-MM-DD" headings over
 * "- fact" lines — the same file the old ~/.pi/agent/extensions/memory.ts used.
 */

/** Cap on what goes into the system prompt; newest facts win when it overflows. */
export const MAX_INJECT_CHARS = 4000;
/** Conversation slice the learning call sees. */
const MAX_TRANSCRIPT_CHARS = 8000;
const MAX_NEW_FACTS = 5;
/** Too short to learn from: a one-shot question says little about the user. */
export const MIN_USER_MESSAGES = 2;

function entryId(date: string, text: string): string {
  return createHash("sha1").update(`${date}\n${text}`).digest("hex").slice(0, 12);
}

export function makeEntry(text: string, date = new Date().toISOString().slice(0, 10)): MemoryEntry {
  const clean = text.replace(/\s+/g, " ").trim();
  return { id: entryId(date, clean), date, text: clean };
}

export function parseMemory(md: string): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  const seen = new Set<string>();
  let date = "";
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    const h = /^##\s+(.+)$/.exec(line);
    if (h) {
      date = h[1].trim();
      continue;
    }
    const m = /^[-*]\s+(.+)$/.exec(line);
    if (!m) continue;
    const e = makeEntry(m[1], date);
    if (!e.text || seen.has(e.text.toLowerCase())) continue;
    seen.add(e.text.toLowerCase());
    out.push(e);
  }
  return out;
}

/** Consecutive facts with the same date share one heading; order is kept. */
export function serializeMemory(entries: MemoryEntry[]): string {
  const lines: string[] = [];
  let date: string | null = null;
  for (const e of entries) {
    const text = e.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (e.date !== date) {
      if (lines.length) lines.push("");
      if (e.date) lines.push(`## ${e.date}`);
      date = e.date;
    }
    lines.push(`- ${text}`);
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** The block appended to the system prompt; empty when there is nothing to say. */
export function memoryPrompt(entries: MemoryEntry[], max = MAX_INJECT_CHARS): string {
  const kept: string[] = [];
  let size = 0;
  for (const e of [...entries].reverse()) {
    const line = `- ${e.text}`;
    if (size + line.length + 1 > max) break;
    kept.unshift(line);
    size += line.length + 1;
  }
  if (!kept.length) return "";
  return [
    "<memory>",
    "Durable facts about the user, remembered from earlier sessions. Apply them without asking;",
    "if the user contradicts one, follow the user.",
    ...kept,
    "</memory>",
  ].join("\n");
}

export const LEARN_SYSTEM_PROMPT = [
  "You maintain a short memory about the USER of a coding assistant.",
  "Read the conversation and write down durable facts about the user: preferences, habits,",
  "environment (OS, hardware, tools), ongoing projects, language, working style.",
  `Rules: only facts still true in future sessions; no one-off task details; no secrets, keys or file contents;`,
  `at most ${MAX_NEW_FACTS} lines; each line one short sentence starting with "- ", written in the language the user writes in.`,
  "Skip anything the existing memory already covers. If there is nothing new, answer exactly: NONE",
].join("\n");

export function learnUserText(existing: MemoryEntry[], transcript: string): string {
  return [
    "Existing memory:",
    existing.length ? existing.map((e) => `- ${e.text}`).join("\n") : "(empty)",
    "",
    "Conversation:",
    transcript.slice(-MAX_TRANSCRIPT_CHARS),
  ].join("\n");
}

/**
 * A model reply that talks to someone instead of stating a fact about the user —
 * exactly what the old extension stored when the model never saw its instructions.
 */
export function looksLikeChatter(line: string): boolean {
  return (
    /\?\s*$/.test(line) ||
    /^(i'?d be happy|i would be happy|sure|certainly|of course|here (are|is)|could you|please|once you|let me|chętnie|oczywiście|oto|czy mógłbyś|podaj)\b/i.test(line) ||
    /\b(you haven'?t provided|i don'?t see any|source material|extract (the )?facts)\b/i.test(line)
  );
}

/** New facts from the model's answer: bullets only, no chatter, nothing already remembered. */
export function parseFacts(out: string, existing: MemoryEntry[]): string[] {
  if (!out.trim() || /^\s*NONE\s*$/i.test(out)) return [];
  const known = new Set(existing.map((e) => e.text.toLowerCase()));
  const fresh: string[] = [];
  for (const raw of out.split("\n")) {
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(raw);
    if (!m) continue;
    const line = m[1].replace(/\*\*/g, "").trim();
    if (line.length < 10 || line.length > 300 || looksLikeChatter(line)) continue;
    if (known.has(line.toLowerCase())) continue;
    known.add(line.toLowerCase());
    fresh.push(line);
    if (fresh.length >= MAX_NEW_FACTS) break;
  }
  return fresh;
}

type Msg = { role?: string; content?: unknown };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : ""))
    .join(" ")
    .trim();
}

/** User and assistant prose only — tool calls and outputs say nothing about the user and eat the budget. */
export function learningTranscript(messages: readonly Msg[]): { text: string; userMessages: number } {
  const parts: string[] = [];
  let userMessages = 0;
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = textOf(m.content);
    if (!text) continue;
    if (m.role === "user") userMessages++;
    parts.push(`${m.role === "user" ? "USER" : "ASSISTANT"}: ${text.length > 1500 ? `${text.slice(0, 1500)}…` : text}`);
  }
  return { text: parts.join("\n\n"), userMessages };
}

export class MemoryStore {
  constructor(readonly file: string) {}

  read(): MemoryEntry[] {
    try {
      return parseMemory(readFileSync(this.file, "utf8"));
    } catch {
      return [];
    }
  }

  write(entries: MemoryEntry[]): MemoryEntry[] {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, serializeMemory(entries));
    renameSync(tmp, this.file);
    return this.read();
  }

  add(facts: string[]): MemoryEntry[] {
    const entries = this.read();
    const known = new Set(entries.map((e) => e.text.toLowerCase()));
    const fresh: MemoryEntry[] = [];
    for (const e of facts.map((f) => makeEntry(f))) {
      if (!e.text || known.has(e.text.toLowerCase())) continue;
      known.add(e.text.toLowerCase());
      fresh.push(e);
    }
    if (!fresh.length) return [];
    this.write([...entries, ...fresh]);
    return fresh;
  }

  get exists(): boolean {
    return existsSync(this.file);
  }
}
