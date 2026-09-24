import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { learningTranscript, looksLikeChatter, memoryPrompt, MemoryStore, makeEntry, parseFacts, parseMemory, serializeMemory } from "./memory";

const OLD = `## 2026-09-23
- Prefers answers in Polish.
- Uses CachyOS with KDE.

## 2026-09-24
- Builds mods for Vintage Story.
- prefers answers in polish.
`;

describe("memory file", () => {
  it("parses dated bullets and drops case-insensitive duplicates", () => {
    const e = parseMemory(OLD);
    expect(e.map((x) => [x.date, x.text])).toEqual([
      ["2026-09-23", "Prefers answers in Polish."],
      ["2026-09-23", "Uses CachyOS with KDE."],
      ["2026-09-24", "Builds mods for Vintage Story."],
    ]);
    expect(new Set(e.map((x) => x.id)).size).toBe(3);
  });

  it("round-trips through serialize", () => {
    const e = parseMemory(OLD);
    expect(parseMemory(serializeMemory(e))).toEqual(e);
    expect(serializeMemory(e)).toBe("## 2026-09-23\n- Prefers answers in Polish.\n- Uses CachyOS with KDE.\n\n## 2026-09-24\n- Builds mods for Vintage Story.\n");
  });

  it("store adds only new facts, dated today", () => {
    const store = new MemoryStore(join(mkdtempSync(join(tmpdir(), "mem-")), "memory", "user.md"));
    expect(store.read()).toEqual([]);
    expect(store.add(["Likes short answers.", "likes short answers."]).length).toBe(1);
    expect(store.add(["Likes short answers."])).toEqual([]);
    expect(readFileSync(store.file, "utf8")).toMatch(/^## \d{4}-\d{2}-\d{2}\n- Likes short answers\.\n$/);
  });
});

describe("prompt block", () => {
  it("is empty without facts and keeps the newest when over budget", () => {
    expect(memoryPrompt([])).toBe("");
    const many = Array.from({ length: 50 }, (_, i) => makeEntry(`Fact number ${i} ${"x".repeat(40)}`, "2026-01-01"));
    const p = memoryPrompt(many, 500);
    expect(p).toContain("Fact number 49");
    expect(p).not.toContain("Fact number 0 ");
    expect(p.startsWith("<memory>")).toBe(true);
  });
});

describe("learning", () => {
  it("rejects the chatter the old extension stored as facts", () => {
    for (const junk of [
      "I'd be happy to help extract facts, but you haven't provided any text, document, or context to work from.",
      "What text or document** should I extract facts from? (Please paste it here.)",
      "Once you share the source material, I'll pull out the factual information for you.",
    ])
      expect(looksLikeChatter(junk.replace(/\*\*/g, ""))).toBe(true);
    expect(looksLikeChatter("Prefers answers in Polish.")).toBe(false);
  });

  it("parses bullets, skips NONE, known facts and chatter", () => {
    const existing = [makeEntry("Uses CachyOS with KDE.")];
    expect(parseFacts("NONE", existing)).toEqual([]);
    const out = "Here are the facts:\n- Uses CachyOS with KDE.\n- Has two RTX 5090 GPUs.\n- **Writes Godot games in C++.**\n- Could you share more?\n1. Prefers local models over cloud APIs.";
    expect(parseFacts(out, existing)).toEqual(["Has two RTX 5090 GPUs.", "Writes Godot games in C++.", "Prefers local models over cloud APIs."]);
  });

  it("transcript keeps prose only and counts user messages", () => {
    const { text, userMessages } = learningTranscript([
      { role: "user", content: [{ type: "text", text: "napraw build" }] },
      { role: "assistant", content: [{ type: "toolCall", name: "bash" }, { type: "text", text: "Naprawione." }] },
      { role: "toolResult", content: [{ type: "text", text: "LOG ".repeat(1000) }] },
      { role: "user", content: "dzięki, zawsze odpowiadaj krótko" },
    ]);
    expect(userMessages).toBe(2);
    expect(text).toBe("USER: napraw build\n\nASSISTANT: Naprawione.\n\nUSER: dzięki, zawsze odpowiadaj krótko");
  });
});
