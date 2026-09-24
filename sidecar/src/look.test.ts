import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { look } from "./look.js";

const PNG = /^iVBORw0KGgo/; // base64 of the PNG signature

describe("look", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-gui-look-t-"));
  writeFileSync(join(dir, "a.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>');
  writeFileSync(join(dir, "g.dot"), "digraph { a -> b }");
  writeFileSync(join(dir, "p.html"), "<h1>hi</h1>");

  it("renders svg and graphviz", async () => {
    const svg = await look({ target: "a.svg", width: 400 }, dir);
    expect(svg.data).toMatch(PNG);
    expect(svg.note).toMatch(/400x200 px/);
    expect((await look({ target: "g.dot" }, dir)).data).toMatch(PNG);
  });

  it("screenshots an html file at the requested size", async () => {
    const r = await look({ target: "p.html", width: 640, height: 480 }, dir);
    expect(r.note).toMatch(/640x480 px/);
  }, 60000);

  it("rejects unknown kinds and missing files", async () => {
    writeFileSync(join(dir, "x.bin"), "x");
    await expect(look({ target: "x.bin" }, dir)).rejects.toThrow(/don't know how/);
    await expect(look({ target: "nope.svg" }, dir)).rejects.toThrow(/not found/);
  });
});
