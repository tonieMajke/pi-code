import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repairEdit } from "./editfix.js";

const SRC = [
  "export function total(items) {",
  "\tlet sum = 0;",
  "\tfor (const it of items) {",
  "\t\tsum += it.price * it.qty;",
  "\t}",
  "\treturn sum;",
  "}",
  "",
  "export function label(x) {",
  "\treturn `#${x}`;",
  "}",
  "",
].join("\n");

function file(content = SRC) {
  const dir = mkdtempSync(join(tmpdir(), "pi-gui-editfix-"));
  writeFileSync(join(dir, "a.js"), content);
  return dir;
}

describe("repairEdit", () => {
  it("leaves edits that already match alone", () => {
    const input = { path: "a.js", edits: [{ oldText: "\tlet sum = 0;", newText: "\tlet sum = 1;" }] };
    expect(repairEdit(input, file())).toBeNull();
  });

  it("fixes indentation-only misses and re-indents newText the file's way", () => {
    const input = {
      path: "a.js",
      edits: [{ oldText: "  for (const it of items) {\n    sum += it.price * it.qty;\n  }", newText: "  for (const it of items) {\n    if (!it) continue;\n    sum += it.price * it.qty;\n  }" }],
    };
    expect(repairEdit(input, file())).toEqual({ fixed: 1 });
    expect(input.edits[0].oldText).toBe("\tfor (const it of items) {\n\t\tsum += it.price * it.qty;\n\t}");
    expect(input.edits[0].newText).toBe("\tfor (const it of items) {\n\t\tif (!it) continue;\n\t\tsum += it.price * it.qty;\n\t}");
  });

  it("works on the legacy single oldText/newText shape too", () => {
    const input = { path: "a.js", oldText: "    return sum;", newText: "    return Math.round(sum);" };
    expect(repairEdit(input, file())).toEqual({ fixed: 1 });
    expect(input.newText).toBe("\treturn Math.round(sum);");
  });

  it("shows the closest real text with line numbers when the model misremembered", () => {
    const input = { path: "a.js", edits: [{ oldText: "\tfor (const item of items) {\n\t\tsum += item.price * item.quantity;", newText: "x" }] };
    const r = repairEdit(input, file());
    expect(r && "block" in r && r.block).toMatch(/closest text is at lines 3–4/);
    expect(r && "block" in r && r.block).toMatch(/    4  \t\tsum \+= it\.price \* it\.qty;/);
  });

  it("names the lines of every occurrence when oldText is not unique", () => {
    const input = { path: "a.js", edits: [{ oldText: "}", newText: "};" }] };
    const r = repairEdit(input, file());
    expect(r && "block" in r && r.block).toMatch(/occurs \d+ times \(lines 5, 7, 11\)/);
  });

  it("says plainly when nothing in the file resembles oldText", () => {
    const input = { path: "a.js", edits: [{ oldText: "import React from 'react';", newText: "" }] };
    const r = repairEdit(input, file());
    expect(r && "block" in r && r.block).toMatch(/nothing close to it/);
  });

  it("stays out of the way for missing files", () => {
    expect(repairEdit({ path: "nope.js", edits: [{ oldText: "a", newText: "b" }] }, file())).toBeNull();
  });
});
