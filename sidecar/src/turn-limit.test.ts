import { describe, expect, it } from "vitest";
import { TurnLimit } from "./turn-limit.js";

const cfg = { enabled: true, steps: 3, minutes: 5 };

/** One assistant message with `calls` tool calls; returns the verdict kinds. */
function step(l: TurnLimit, calls = 1, text = false) {
  l.messageEnd(text);
  return Array.from({ length: calls }, () => l.beforeTool(cfg)?.kind ?? null);
}

describe("TurnLimit", () => {
  it("asks for a status after N silent steps, then stops the run if the next message ignores it", () => {
    const l = new TurnLimit(() => 0);
    l.reset();
    expect([step(l), step(l), step(l)]).toEqual([[null], [null], [null]]);
    expect(step(l)).toEqual(["status"]);
    expect(step(l)).toEqual(["stop"]);
  });

  it("counts a parallel batch as one step, and asks once per batch without stopping", () => {
    const l = new TurnLimit(() => 0);
    l.reset();
    expect(step(l, 14, true)).toEqual(Array(14).fill(null)); // status line + 14 edits
    step(l);
    step(l);
    expect(step(l, 5)).toEqual(Array(5).fill("status"));
  });

  it("starts counting again once the model says something", () => {
    const l = new TurnLimit(() => 0);
    l.reset();
    for (let i = 0; i < 4; i++) step(l);
    expect(step(l, 1, true)).toEqual([null]);
  });

  it("counts minutes without text, and can be off", () => {
    let t = 0;
    const l = new TurnLimit(() => t);
    l.reset();
    expect(step(l)).toEqual([null]);
    t = 6 * 60_000; // one long tool call
    expect(step(l)).toEqual(["status"]);
    const off = new TurnLimit(() => 0);
    off.reset();
    for (let i = 0; i < 9; i++) off.messageEnd(false);
    expect(off.beforeTool({ ...cfg, enabled: false })).toBeNull();
  });
});
