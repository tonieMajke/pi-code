// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { countIn, findMatches, hitsOf, paintFind, rangesIn } from "./find";
import type { Msg } from "./reducer";

const messages: Msg[] = [
  { role: "user", text: "Uruchom testy i napraw Błąd" },
  {
    role: "assistant",
    open: false,
    parts: [
      { type: "thinking", text: "najpierw testy, potem błąd" },
      { type: "text", text: "Uruchamiam." },
      {
        type: "tool",
        tool: { id: "b1", name: "bash", args: { command: "pnpm test" }, status: "error", summary: "FAIL a.test.ts\nError: błąd w linii 3\nbłąd" },
      },
      { type: "tool", tool: { id: "e1", name: "edit", args: { path: "/w/a.ts", edits: [{ oldText: "x", newText: "y // błąd" }] }, status: "ok", summary: "" } },
    ],
  },
  { role: "info", text: "Kontekst skompaktowany.", level: "info" },
];

describe("findMatches", () => {
  it("counts case-insensitively, per block and field", () => {
    expect(countIn("Błąd błąd BŁĄD", "błąd")).toBe(3);
    expect(findMatches(messages, "błąd")).toEqual([
      { msgIndex: 0, partIndex: 0, field: "text", count: 1 },
      { msgIndex: 1, partIndex: 0, field: "thinking", count: 1 },
      { msgIndex: 1, partIndex: 2, field: "tool-output", count: 2 },
      { msgIndex: 1, partIndex: 3, field: "tool-args", count: 1 },
    ]);
  });

  it("finds bash output that is not on screen (collapsed card)", () => {
    const m = findMatches(messages, "FAIL a.test");
    expect(m).toEqual([{ msgIndex: 1, partIndex: 2, field: "tool-output", count: 1 }]);
  });

  it("searches tool args (command) and info rows; empty query finds nothing", () => {
    expect(findMatches(messages, "pnpm")).toEqual([{ msgIndex: 1, partIndex: 2, field: "tool-args", count: 1 }]);
    expect(findMatches(messages, "skompaktowany")[0]).toMatchObject({ msgIndex: 2, field: "text" });
    expect(findMatches(messages, "  ")).toEqual([]);
  });

  it("one hit per occurrence, in order", () => {
    const hits = hitsOf(findMatches(messages, "błąd"));
    expect(hits).toHaveLength(5);
    expect(hits.map((h) => `${h.msgIndex}.${h.partIndex}.${h.occ}`)).toEqual(["0.0.0", "1.0.0", "1.2.0", "1.2.1", "1.3.0"]);
  });
});

describe("paintFind (DOM)", () => {
  it("finds ranges across text nodes and outlines the hit's block without the Highlight API", () => {
    document.body.innerHTML = `
      <div id="col">
        <div class="msg user" data-msg="0" data-part="0"><div class="bubble">Napraw <b>błąd</b></div></div>
        <div class="msg assistant" data-msg="1">
          <div class="tool open" data-part="2"><pre class="term-out">Error: błąd\nbłąd</pre></div>
        </div>
      </div>`;
    const col = document.getElementById("col")!;
    expect(rangesIn(col, "BŁĄD")).toHaveLength(3);
    const { block, current } = paintFind(col, "błąd", { msgIndex: 1, partIndex: 2, field: "tool-output", count: 2, occ: 1 });
    expect(block?.getAttribute("data-part")).toBe("2");
    expect(current?.startContainer.nodeValue).toContain("błąd");
    expect(current?.startOffset).toBe("Error: błąd\n".length);
    // jsdom has no CSS.highlights → the block gets the fallback outline
    expect(block?.classList.contains("find-block")).toBe(true);
    paintFind(col, "", null);
    expect(col.querySelector(".find-block")).toBeNull();
  });
});
