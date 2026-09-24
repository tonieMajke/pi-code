import { describe, expect, it } from "vitest";
import { changedLines, parseVerdict, reviewPrompt } from "./review.js";

describe("review", () => {
  it("parses OK and ISSUES verdicts, last one wins", () => {
    expect(parseVerdict("looks fine\nVERDICT: OK")).toEqual({ ok: true, issues: "" });
    const v = parseVerdict("Thinking VERDICT: OK maybe\n- calc.py: add still subtracts\n- x.ts: unused import\nVERDICT: ISSUES");
    expect(v.ok).toBe(false);
    expect(v.issues).toBe("- calc.py: add still subtracts\n- x.ts: unused import");
  });
  it("treats garbage as OK", () => {
    expect(parseVerdict("I am not sure.").ok).toBe(true);
  });
  it("truncates huge diffs", () => {
    expect(reviewPrompt("t", "y".repeat(30000))).toMatch(/diff truncated, 6000 more chars/);
  });
});

describe("changedLines", () => {
  it("counts added and removed lines, not file headers", () => {
    const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n+d\n";
    expect(changedLines(diff)).toBe(3);
  });
});
