import { describe, expect, it } from "vitest";
import { withMidrunNote } from "../../shared/midrun.js";
import { elideOldImages, elideOldToolOutput, runStart } from "./elide.js";

const big = "x".repeat(5000);
const tool = (text: string) => ({ role: "toolResult", content: [{ type: "text", text }] });
const shot = (n: number) => ({ role: "toolResult", content: [{ type: "text", text: `shot ${n}` }, { type: "image", data: "…" }] });
const hasImage = (m: { content?: unknown }) => Array.isArray(m.content) && (m.content as { type: string }[]).some((b) => b.type === "image");

describe("runStart", () => {
  it("skips mid-run messages and guardian steers", () => {
    const msgs = [
      { role: "user", content: "task" },
      tool("a"),
      { role: "user", content: [{ type: "text", text: withMidrunNote("co tam?") }] },
      tool("b"),
      { role: "user", content: "[strażnik] Tura przekroczyła 8 tool calls" },
    ];
    expect(runStart(msgs)).toBe(0);
    expect(runStart([...msgs, { role: "user", content: "next task" }])).toBe(5);
    expect(runStart([tool("a")])).toBe(-1);
  });

  it("does not re-shorten outputs when a message arrives mid-run", () => {
    const msgs = [{ role: "user", content: "old" }, tool(big), { role: "user", content: "task" }, tool(big)];
    const before = elideOldToolOutput(msgs, 2000);
    const after = elideOldToolOutput([...msgs, { role: "user", content: withMidrunNote("co tam?") }], 2000);
    expect(after.slice(0, 4)).toEqual(before);
    expect(after[3]).toBe(msgs[3]);
  });
});

describe("elideOldImages", () => {
  it("drops screenshots a batch at a time, so the prefix breaks rarely", () => {
    const run = (n: number) => [{ role: "user", content: "task" }, ...Array.from({ length: n }, (_, i) => shot(i))];
    const kept = (n: number) => elideOldImages(run(n), 3, 6).filter(hasImage).length;
    expect([3, 5, 8, 9, 10, 14, 15].map(kept)).toEqual([3, 5, 8, 3, 4, 8, 3]);
    // between batches the older part is identical, request after request
    expect(elideOldImages(run(11), 3, 6).slice(0, 11)).toEqual(elideOldImages(run(10), 3, 6));
  });
});
