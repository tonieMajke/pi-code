import { describe, expect, it } from "vitest";
import { applySampling } from "./perf.js";

const OFF = { enabled: true, temperature: null, top_p: null, top_k: null, min_p: null, presence_penalty: null, repeat_penalty: null, reasoning_budget_tokens: null };

describe("applySampling", () => {
  it("sends the thinking budget with a closing sentence, and nothing when unset or disabled", () => {
    const a: Record<string, unknown> = {};
    applySampling(a, { ...OFF, reasoning_budget_tokens: 4096, temperature: 0.6 });
    expect(a).toMatchObject({ reasoning_budget_tokens: 4096, temperature: 0.6 });
    expect(a.reasoning_budget_message).toMatch(/thought enough/);
    const b: Record<string, unknown> = {};
    applySampling(b, OFF);
    expect(b).toEqual({});
    applySampling(b, { ...OFF, enabled: false, reasoning_budget_tokens: 4096 });
    expect(b).toEqual({});
  });
});
