import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { closeBrowser } from "./browser.js";
import { look, lookCompare } from "./look.js";

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

describe("look extras", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-gui-look-x-"));
  writeFileSync(join(dir, "a.html"), "<body style='margin:0;background:#fff'><h1 style='font:600 32px system-ui'>Left</h1></body>");
  writeFileSync(join(dir, "b.html"), "<body style='margin:0;background:#222;color:#eee'><h1 style='font:600 32px system-ui'>Right</h1></body>");

  it("puts two renders side by side in one image no wider than the render width", async () => {
    const r = await lookCompare({ a: "a.html", b: "b.html", width: 800 }, dir);
    expect(r.data).toMatch(PNG);
    expect(r.note).toMatch(/left REFERENCE = a\.html, right YOURS = b\.html/);
    const [, w] = /→ (\d+)x/.exec(r.note)!;
    expect(Number(w)).toBeLessThanOrEqual(804);
  }, 60000);

  it("zooms a crop 2x", async () => {
    const r = await look({ target: "a.html", width: 640, height: 480, crop: { x: 0, y: 0, w: 100, h: 50 } }, dir);
    expect(r.note).toMatch(/crop 100x50 at 0,0 zoomed 2x → 200x100 px/);
  }, 60000);

  afterAll(() => closeBrowser());
});

describe("look warnings", () => {
  afterAll(() => closeBrowser());

  it("says so when the page threw or rendered nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-gui-look-warn-"));
    writeFileSync(join(dir, "black.html"), `<body style="margin:0;background:#000"><canvas id=c width=800 height=600></canvas><script>undefinedThing.draw()</script></body>`);
    const r = await look({ target: "black.html" }, dir);
    expect(r.note).toMatch(/→ \d+x\d+ px/);
    expect(r.note).toMatch(/JS error: .*undefinedThing/);
    expect(r.note).toMatch(/almost a single flat colour \(#000000\)/);

    writeFileSync(join(dir, "ok.html"), `<body style="font:24px sans-serif"><h1>Hello</h1><p>Some text on a page that works.</p></body>`);
    const ok = await look({ target: "ok.html" }, dir);
    expect(ok.note).not.toMatch(/⚠/);
  }, 60000);
});
