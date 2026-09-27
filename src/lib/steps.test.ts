import { describe, expect, it } from "vitest";
import type { Part, ToolItem } from "./reducer";
import { groupSteps, summarizeSteps, toBlocks } from "./steps";

const tool = (name: string, extra: Partial<ToolItem> = {}): Part => ({ type: "tool", tool: { id: `${name}${Math.random()}`, name, args: {}, status: "ok", summary: "", ...extra } });
const think = (start?: number, end?: number): Part => ({ type: "thinking", text: "hm", start, end });
const text = (t: string): Part => ({ type: "text", text: t });
const kinds = (parts: Part[], open = false, keep: (i: number) => boolean = () => false) => groupSteps(toBlocks(parts), open, keep).map((b) => b.kind);

describe("groupSteps", () => {
  it("folds a finished chain of 3+ steps between texts; short ones stay", () => {
    const parts = [text("a"), think(), tool("bash"), tool("edit"), text("b"), think(), tool("read"), text("c")];
    expect(kinds(parts)).toEqual(["part", "steps", "part", "part", "tools", "part"]);
  });

  it("the chain still growing at the end of an open turn stays expanded", () => {
    const parts = [think(), tool("bash"), tool("bash"), tool("edit")];
    expect(kinds(parts, true)).toEqual(["part", "tools"]);
    expect(kinds(parts, false)).toEqual(["steps"]);
  });

  it("screenshots and a reasoning that answers the user break the chain", () => {
    const shot = tool("look", { images: [{ data: "x", mimeType: "image/png" }] });
    expect(kinds([think(), tool("bash"), shot, think(), tool("bash"), tool("bash"), text("x")])).toEqual(["part", "tools", "steps", "part"]);
    expect(kinds([think(), tool("bash"), tool("bash"), text("x")], false, (i) => i === 0)).toEqual(["part", "tools", "part"]);
  });
});

describe("summarizeSteps", () => {
  it("counts by kind, most first, with Polish forms, errors and time", () => {
    const parts = [
      think(1000, 3000),
      tool("bash", { start: 3000, end: 5000 }),
      tool("bash", { start: 5000, end: 9000, status: "error" }),
      tool("bash"),
      tool("edit", { start: 9000, end: 121000 }),
      think(),
    ];
    const s = summarizeSteps(parts, [0, 1, 2, 3, 4, 5]);
    expect(s.label).toBe("6 kroków: 3 polecenia, 2 przemyślenia, 1 edycja");
    expect(s.errors).toBe(1);
    expect(s.ms).toBe(120000);
  });

  it("history without times: no duration", () => {
    expect(summarizeSteps([tool("read"), tool("grep"), tool("grep")], [0, 1, 2])).toMatchObject({ label: "3 kroki: 2 wyszukiwania, 1 odczyt", ms: null });
  });
});
