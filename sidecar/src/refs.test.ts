import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { criticPrompt, pickReference } from "./critic.js";
import { elideOldImages } from "./elide.js";
import { designRefs, hasRefs, pickImages, projectRefs, qualityProblem, refMode, topicSlug } from "./refs.js";

const hit = (image: string, page: string, width = 1200, height = 800) => ({ image, page, width, height, title: "" });

describe("design_refs helpers", () => {
  it("slugs topics", () => {
    expect(topicSlug("Stylized Goblin — 3D!")).toBe("stylized-goblin-3d");
    expect(topicSlug("Piekarnia Żółć")).toBe("piekarnia-zolc");
    expect(topicSlug("???")).toBe("ui");
  });

  it("guesses ui vs image from the query", () => {
    expect(refMode({ topic: "b", query: "artisan bakery website" })).toBe("ui");
    expect(refMode({ topic: "k", query: "kanban board app for small teams" })).toBe("ui");
    expect(refMode({ topic: "g", query: "stylized goblin 3d character" })).toBe("image");
    expect(refMode({ topic: "g", query: "website", kind: "image" })).toBe("image");
  });

  it("keeps big, non-stock images, one per site", () => {
    const picked = pickImages([
      hit("https://a.com/1.jpg", "https://a.com/x"),
      hit("https://a.com/2.jpg", "https://a.com/y"),
      hit("https://image.shutterstock.com/z.jpg", "https://www.shutterstock.com/z"),
      hit("https://b.com/tiny.jpg", "https://b.com/t", 200, 150),
      hit("https://c.com/pano.jpg", "https://c.com/p", 4000, 500),
      hit("https://d.com/ok.png", "https://d.com/o"),
    ]);
    expect(picked.map((p) => p.page).sort()).toEqual([expect.stringMatching(/^https:\/\/a\.com/), "https://d.com/o"]);
  });

  it("lets only decent pages through the quality gate", () => {
    const summary = { elements: 200, severeContrast: 0 };
    expect(qualityProblem({ issues: [], summary })).toBeNull();
    expect(qualityProblem({ issues: [{ rule: "default-font", severity: "high" }], summary })).toMatch(/default-font/);
    expect(qualityProblem({ issues: [], summary: { elements: 200, severeContrast: 4 } })).toMatch(/hard to read/);
    // Mild WCAG misses (brand-colour buttons) are common on good sites and don't disqualify.
    expect(qualityProblem({ issues: [{ rule: "contrast", severity: "high" }, { rule: "contrast", severity: "high" }, { rule: "contrast", severity: "high" }], summary })).toBeNull();
    expect(qualityProblem({ issues: [], summary: { elements: 10, severeContrast: 0 } })).toMatch(/empty/);
  });

  it("finds project references, newest topic first, and the one the brief liked", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-gui-refs-"));
    expect(hasRefs(cwd)).toBe(false);
    expect(pickReference(cwd)).toBeNull();
    const dir = join(cwd, ".pi", "design-refs", "bakery");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01-a-com.png"), "x");
    writeFileSync(join(dir, "02-b-com.png"), "x");
    expect(hasRefs(cwd)).toBe(true);
    expect(projectRefs(cwd).map((p) => p.split("/").pop())).toEqual(["01-a-com.png", "02-b-com.png"]);
    expect(pickReference(cwd)).toMatch(/01-a-com\.png$/);
    writeFileSync(join(dir, "brief.md"), "References I liked and why: 02-b-com.png — calm type");
    expect(pickReference(cwd)).toMatch(/02-b-com\.png$/);
  });
});

/** The gallery fixtures and the contact sheet need ImageMagick 7 (`magick`). */
const hasMagick = spawnSync("sh", ["-c", "command -v magick"]).status === 0;

describe.skipIf(!hasMagick)("designRefs offline", () => {
  it("falls back to the local gallery and writes sources + a contact sheet", async () => {
    const gallery = mkdtempSync(join(tmpdir(), "pi-gui-gallery-"));
    for (const name of ["bakery-warm", "bakery-dark", "fintech"])
      execFileSync("magick", ["-size", "640x400", "plasma:", join(gallery, `${name}.png`)]);
    process.env.PI_GUI_GALLERY = gallery;
    const cwd = mkdtempSync(join(tmpdir(), "pi-gui-refs-off-"));
    const r = await designRefs({ topic: "bakery", query: "bakery website" }, cwd, { offline: true });
    expect(r.kind).toBe("ui");
    expect(r.captured.length).toBe(3);
    expect(r.captured.slice(0, 2).every((c) => /bakery/.test(c.url))).toBe(true); // matching names first
    expect(r.sheet && existsSync(r.sheet)).toBe(true);
    expect(JSON.parse(readFileSync(join(r.dir, "sources.json"), "utf8"))).toHaveLength(3);
    expect(r.text).toMatch(/brief\.md/);
  }, 60000);
});

describe("critic prompt", () => {
  it("frames a page review against the reference, with the audit", () => {
    const p = criticPrompt({ task: "Make a pricing page", kind: "ui", hasReference: true, audit: "ui_audit x: 1 high" });
    expect(p).toMatch(/LEFT = a reference/);
    expect(p).toMatch(/phone width/);
    expect(p).toMatch(/Measured problems/);
    expect(p).toMatch(/VERDICT: ISSUES/);
  });

  it("frames 3D work by silhouette and proportions, and text mode with an outline", () => {
    expect(criticPrompt({ task: "goblin", kind: "image", hasReference: false })).toMatch(/silhouette/);
    expect(criticPrompt({ task: "page", kind: "ui", hasReference: false, outline: "body 0,0 1280x900" })).toMatch(/cannot see images/);
  });
});

describe("elideOldImages", () => {
  const img = { type: "image", data: "x", mimeType: "image/png" };
  it("keeps only the newest screenshots of the current run (batch of 1)", () => {
    const msgs = [
      { role: "toolResult", content: [img] }, // earlier run — untouched here
      { role: "user", content: "go" },
      { role: "toolResult", content: [img, { type: "text", text: "a" }] },
      { role: "toolResult", content: [img] },
      { role: "toolResult", content: [img] },
    ];
    const out = elideOldImages(msgs, 2, 1);
    expect(out[0]).toBe(msgs[0]);
    expect(out[2].content).toEqual([{ type: "text", text: "a" }, { type: "text", text: expect.stringMatching(/older screenshot/) }]);
    expect(out[3]).toBe(msgs[3]);
    expect(elideOldImages(msgs, 5)).toBe(msgs);
  });
});
