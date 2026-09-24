import { describe, expect, it } from "vitest";
import { applySampling } from "./perf.js";

const OFF = { enabled: false, temperature: null, top_p: null, top_k: null, min_p: null, presence_penalty: null, repeat_penalty: null, reasoning_budget_tokens: null };

describe("applySampling", () => {
  it("sends the thinking budget on its own, with a closing sentence", () => {
    const a: Record<string, unknown> = {};
    applySampling(a, { ...OFF, reasoning_budget_tokens: 4096, temperature: 0.6 });
    expect(a.reasoning_budget_tokens).toBe(4096);
    expect(a.reasoning_budget_message).toMatch(/thought enough/);
    expect(a.temperature).toBeUndefined(); // the override switch is off
  });

  it("sends sampling overrides only when switched on, and no budget when unset", () => {
    const b: Record<string, unknown> = {};
    applySampling(b, OFF);
    expect(b).toEqual({});
    applySampling(b, { ...OFF, enabled: true, temperature: 0.6 });
    expect(b).toEqual({ temperature: 0.6 });
  });
});
