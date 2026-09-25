import { describe, expect, it } from "vitest";
import { formatClock, insertDictation } from "./voice-meter";

describe("insertDictation", () => {
  it("empty box: just the text", () => {
    expect(insertDictation("", 0, 0, "i nie ma")).toEqual({ value: "i nie ma", caret: 8 });
  });
  it("after a word: a space in between; before punctuation: none", () => {
    expect(insertDictation("Popraw", 6, 6, "ten test")).toEqual({ value: "Popraw ten test", caret: 15 });
    expect(insertDictation("Zrób to.", 7, 7, "teraz")).toEqual({ value: "Zrób to teraz.", caret: 13 });
  });
  it("in the middle of text: spaces on both sides, selection replaced", () => {
    expect(insertDictation("ab XX cd", 3, 5, "słowo")).toEqual({ value: "ab słowo cd", caret: 8 });
    expect(insertDictation("abcd", 2, 2, "x")).toEqual({ value: "ab x cd", caret: 4 });
  });
});

describe("formatClock", () => {
  it("m:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(7.9)).toBe("0:07");
    expect(formatClock(125)).toBe("2:05");
  });
});
