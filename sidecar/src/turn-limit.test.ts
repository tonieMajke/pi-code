import { describe, expect, it } from "vitest";
import { TurnLimit } from "./turn-limit.js";

const cfg = { enabled: true, toolCalls: 3, minutes: 5 };

describe("TurnLimit", () => {
  it("asks for a status after N silent calls, then stops the run if ignored", () => {
    const l = new TurnLimit(() => 0);
    l.reset();
    expect([1, 2, 3].map(() => l.beforeTool(cfg))).toEqual([null, null, null]);
    expect(l.beforeTool(cfg)?.kind).toBe("status");
    expect(l.beforeTool(cfg)?.kind).toBe("stop");
  });

  it("starts counting again once the model says something", () => {
    const l = new TurnLimit(() => 0);
    l.reset();
    for (let i = 0; i < 4; i++) l.beforeTool(cfg);
    l.reset(); // visible text
    expect(l.beforeTool(cfg)).toBeNull();
  });

  it("counts minutes without text, and can be off", () => {
    let t = 0;
    const l = new TurnLimit(() => t);
    l.reset();
    expect(l.beforeTool(cfg)).toBeNull();
    t = 6 * 60_000; // one long tool call
    expect(l.beforeTool(cfg)?.kind).toBe("status");
    expect(new TurnLimit(() => 0).beforeTool({ ...cfg, enabled: false, toolCalls: 0 })).toBeNull();
  });
});
