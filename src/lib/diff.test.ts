import { describe, expect, it } from "vitest";
import { countChanges, diffText } from "./diff";

const kinds = (d: ReturnType<typeof diffText>) => d.map((l) => (l.type === "gap" ? `gap${l.count}` : `${l.type}:${l.text}`));

describe("diffText", () => {
  it("keeps unchanged lines as context and counts only what changed", () => {
    const d = diffText("a\nb\nc\nd", "a\nB\nc\nd\ne");
    expect(kinds(d)).toEqual(["eq:a", "del:b", "add:B", "eq:c", "eq:d", "add:e"]);
    expect(countChanges(d)).toEqual({ add: 2, del: 1 });
  });

  it("folds long unchanged runs, keeping 3 lines around changes", () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const neu = [...old];
    neu[10] = "zmiana";
    const d = diffText(old.join("\n"), neu.join("\n"));
    expect(kinds(d)).toEqual(["gap7", "eq:l7", "eq:l8", "eq:l9", "del:l10", "add:zmiana", "eq:l11", "eq:l12", "eq:l13", "gap6"]);
  });

  it("marks the changed words of a replaced line", () => {
    const [del, add] = diffText("const total = price * qty;", "const total = price * qty * (1 - rabat);");
    expect(del.type === "del" && del.segs?.some((s) => s.changed)).toBe(false);
    expect(add.type === "add" && add.segs?.filter((s) => s.changed).map((s) => s.text)).toEqual([" * (1 - rabat)"]);
  });

  it("a line rewritten from scratch gets no word marks", () => {
    const [del, add] = diffText("return foo(bar);", "throw new Error('x');");
    expect(del.type === "del" && del.segs).toBeUndefined();
    expect(add.type === "add" && add.segs).toBeUndefined();
  });
});
