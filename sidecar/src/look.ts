import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { open, withPage } from "./browser.js";

const run = promisify(execFile);

/**
 * "Eyes" for the model: render whatever it just made to a PNG it can look at.
 * Small models write UI/SVG/diagrams blind; seeing the result is most of what
 * separates them from frontier output. Everything runs locally (headless
 * Firefox, rsvg-convert, graphviz, ImageMagick).
 */
export type Crop = { x: number; y: number; w: number; h: number };
export type LookInput = { target: string; width?: number; height?: number; fullPage?: boolean; crop?: Crop };
export type LookResult = { data: string; mimeType: "image/png"; note: string };

const RASTER = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const PAGE = new Set([".html", ".htm", ".xhtml"]);
const MAX_SIDE = 1600;
/** Full-page shots of long pages get cut here — past this the model can't read it anyway. */
const MAX_PAGE_HEIGHT = 4000;

export const LOOK_DESCRIPTION =
  "Render something visual and look at it: a web page (http://localhost:… dev server URL or an .html file), " +
  ".svg, a Graphviz diagram (.dot/.gv), a Mermaid diagram (.mmd), or an image file. Returns a screenshot you can see. " +
  "Use it after every visual change (UI, CSS, SVG, diagram, generated image) and fix what looks wrong before finishing. " +
  "fullPage captures the whole scrolling page; crop {x,y,w,h} (page pixels) zooms into a detail at 2x. " +
  "For Blender/Blockbench scenes use their MCP screenshot tools instead.";

export const LOOK_COMPARE_DESCRIPTION =
  "Put two things side by side in ONE image to compare them: a reference (e.g. a .pi/design-refs/… screenshot) " +
  "on the left, your page (URL or .html) on the right. Both are rendered at the same width and cut to the first screen. " +
  "Then list the concrete differences that make yours look worse and fix them.";

export function resolveTarget(target: string, cwd: string): { kind: "url"; url: string } | { kind: "file"; path: string } {
  if (/^https?:\/\//i.test(target) || target.startsWith("file://")) return { kind: "url", url: target };
  const clean = target.startsWith("@") ? target.slice(1) : target;
  const path = isAbsolute(clean) ? clean : resolve(cwd, clean);
  if (!existsSync(path)) throw new Error(`not found: ${target}`);
  return { kind: "file", path };
}

async function firefoxShot(url: string, out: string, width: number, height: number): Promise<void> {
  // A throwaway profile: works while the user's Firefox is open, leaves nothing behind.
  const profile = mkdtempSync(join(tmpdir(), "pi-gui-ff-"));
  try {
    await run(
      "firefox",
      ["--headless", "--no-remote", "--profile", profile, `--window-size=${width},${height}`, "--screenshot", out, url],
      { timeout: 45000 },
    );
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
  if (!existsSync(out)) throw new Error("firefox produced no screenshot (page failed to load?)");
}

/** Page screenshot through the shared browser; the one-shot Firefox CLI is the fallback. */
/**
 * Screenshot a page. Returns what the page itself complained about (JS errors, console
 * errors, WebGL/shader messages) — a pretty screenshot of a page that threw is a lie.
 */
export async function pageShot(url: string, out: string, width: number, height: number, fullPage = false): Promise<string[]> {
  const problems: string[] = [];
  try {
    await withPage({ width, height }, async (page) => {
      const onError = (err: unknown) => problems.push(`JS error: ${err instanceof Error ? err.message : String(err)}`);
      const onConsole = (msg: { type(): string; text(): string }) => {
        const text = msg.text();
        if (msg.type() === "error" || /webgl|shader|glsl/i.test(text)) problems.push(`console ${msg.type()}: ${text}`);
      };
      page.on("pageerror", onError);
      page.on("console", onConsole);
      try {
        await open(page, url);
      if (fullPage) {
        const h = await page.evaluate(() => document.scrollingElement?.scrollHeight ?? 0);
        await page.screenshot({ path: out as `${string}.png`, clip: { x: 0, y: 0, width, height: Math.min(Math.max(h, height), MAX_PAGE_HEIGHT) }, captureBeyondViewport: true });
      } else {
        await page.screenshot({ path: out as `${string}.png` });
      }
      } finally {
        page.off("pageerror", onError);
        page.off("console", onConsole);
      }
    });
  } catch (err) {
    if (fullPage) throw err;
    await firefoxShot(url, out, width, height);
  }
  return [...new Set(problems.map((p) => p.slice(0, 300)))].slice(0, 8);
}


function mermaidPage(source: string): string {
  const escaped = source.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!doctype html><html><body style="margin:16px;background:#fff">
<pre class="mermaid">${escaped}</pre>
<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
mermaid.initialize({ startOnLoad: false });
await mermaid.run();
</script></body></html>`;
}

/** Render a target into `out` (PNG, unscaled). Returns a human note. */
async function render(input: LookInput, cwd: string, dir: string, out: string): Promise<string> {
  const width = Math.min(Math.max(input.width ?? 1280, 200), 2560);
  const height = Math.min(Math.max(input.height ?? 800, 200), 4000);
  const t = resolveTarget(input.target, cwd);
  const size = `${width}x${height}${input.fullPage ? " full page" : ""}`;
  if (t.kind === "url") {
    const problems = await pageShot(t.url, out, width, height, input.fullPage);
    return `screenshot of ${t.url} at ${size}${problemNote(problems)}`;
  }
  const ext = extname(t.path).toLowerCase();
  if (PAGE.has(ext)) {
    const problems = await pageShot(pathToFileURL(t.path).href, out, width, height, input.fullPage);
    return `screenshot of ${input.target} at ${size}${problemNote(problems)}`;
  }
  if (ext === ".svg") {
    await run("rsvg-convert", ["--width", String(Math.min(width, 1600)), "--keep-aspect-ratio", "--background-color", "white", "-o", out, t.path], { timeout: 30000 });
    return `render of ${input.target} (white background added)`;
  }
  if (ext === ".dot" || ext === ".gv") {
    await run("dot", ["-Tpng", "-Gdpi=110", "-o", out, t.path], { timeout: 30000 });
    return `graphviz render of ${input.target}`;
  }
  if (ext === ".mmd" || ext === ".mermaid") {
    const page = join(dir, "mermaid.html");
    writeFileSync(page, mermaidPage(readFileSync(t.path, "utf8")));
    await pageShot(pathToFileURL(page).href, out, width, height);
    return `mermaid render of ${input.target} (needs network for the mermaid script)`;
  }
  if (RASTER.has(ext)) {
    await run("magick", [t.path, "-auto-orient", out], { timeout: 30000 });
    return `image ${input.target}`;
  }
  throw new Error(`don't know how to render ${ext || "this file"} — supported: URL, .html, .svg, .dot/.gv, .mmd, images`);
}

function problemNote(problems: string[]): string {
  if (!problems.length) return "";
  return `\n⚠ The page reported problems while loading — fix these before judging the picture:\n${problems.map((p) => `- ${p}`).join("\n")}`;
}

/**
 * A render that is (almost) one flat colour: an empty page, a black canvas, a scene that
 * did not draw. Returns a warning, or "".
 */
export async function blankWarning(file: string): Promise<string> {
  try {
    const { stdout } = await run("magick", [file, "-colorspace", "sRGB", "-format", "%[fx:standard_deviation] %[hex:u.p{0,0}]", "info:"], { timeout: 30000 });
    const [sd, hex] = stdout.trim().split(" ");
    if (Number(sd) >= 0.015) return "";
    return `\n⚠ The picture is almost a single flat colour (#${hex.slice(0, 6)}): the page is empty, black or did not draw. Do not call this done — find out why (console errors, a canvas that never renders, content hidden or off-screen).`;
  } catch {
    return "";
  }
}

let labelFont: Promise<string[]> | null = null;
/** ImageMagick's default font is whatever it finds first (here: a script face) — ask fontconfig. */
export function fontArgs(): Promise<string[]> {
  labelFont ??= run("fc-match", ["-f", "%{file}", "sans:bold"])
    .then(({ stdout }) => (stdout.trim() ? ["-font", stdout.trim()] : []))
    .catch(() => []);
  return labelFont;
}

async function dims(file: string): Promise<{ w: number; h: number }> {
  const { stdout } = await run("magick", ["identify", "-format", "%w %h", file]);
  const [w, h] = stdout.trim().split(" ").map(Number);
  return { w, h };
}

export async function look(input: LookInput, cwd: string): Promise<LookResult> {
  const dir = mkdtempSync(join(tmpdir(), "pi-gui-look-"));
  const out = join(dir, "out.png");
  try {
    let note = await render(input, cwd, dir, out);
    if (input.crop) {
      const { x, y, w, h } = input.crop;
      const cw = Math.max(8, Math.round(w)), ch = Math.max(8, Math.round(h));
      // Zoom 2x so details (1px borders, 4px gaps) become visible to the model.
      await run("magick", [out, "-crop", `${cw}x${ch}+${Math.max(0, Math.round(x))}+${Math.max(0, Math.round(y))}`, "+repage", "-filter", "point", "-resize", "200%", out], { timeout: 30000 });
      note += `, crop ${cw}x${ch} at ${Math.round(x)},${Math.round(y)} zoomed 2x`;
    }
    const blank = input.crop ? "" : await blankWarning(out);
    // Keep the model's image budget sane.
    await run("magick", [out, "-resize", `${MAX_SIDE}x${MAX_SIDE}>`, out], { timeout: 30000 });
    const d = await dims(out);
    // Warnings (page errors, flat picture) go last, after the size, where they are read.
    const [head, ...warn] = note.split("\n⚠");
    const tail = [...warn.map((w) => `\n⚠${w}`), blank].join("");
    return { data: readFileSync(out).toString("base64"), mimeType: "image/png", note: `${head} → ${d.w}x${d.h} px${tail}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type CompareInput = { a: string; b: string; width?: number; labels?: [string, string] };

/**
 * Two renders side by side in one PNG: small models compare one picture far better
 * than two separate ones. Each side is rendered at `width`, cut to the first screen
 * (height = 0.75 × width), and scaled to half so the whole thing stays ≤ `width` px wide.
 */
export async function lookCompare(input: CompareInput, cwd: string, outFile?: string): Promise<LookResult> {
  const width = Math.min(Math.max(input.width ?? 1280, 600), 1600);
  const firstScreen = Math.round(width * 0.75);
  const [la, lb] = input.labels ?? ["REFERENCE", "YOURS"];
  const dir = mkdtempSync(join(tmpdir(), "pi-gui-cmp-"));
  try {
    const side = async (target: string, name: string, label: string) => {
      const raw = join(dir, `${name}-raw.png`);
      await render({ target, width, height: firstScreen }, cwd, dir, raw);
      const f = join(dir, `${name}.png`);
      // Same width for both sides, then the first screen only.
      await run("magick", [raw, "-resize", `${width}x`, "-crop", `${width}x${firstScreen}+0+0`, "+repage", "-resize", "50%",
        "-background", "#f2f2f2", "-gravity", "north", "-splice", "0x26", ...(await fontArgs()), "-fill", "#222", "-pointsize", "15", "-annotate", "+0+5", label, f], { timeout: 30000 });
      return f;
    };
    const fa = await side(input.a, "a", la);
    const fb = await side(input.b, "b", lb);
    const out = join(dir, "compare.png");
    await run("magick", [fa, fb, "-background", "#c8c8c8", "-splice", "4x0", "+append", "-chop", "4x0", out], { timeout: 30000 });
    if (outFile) copyFileSync(out, outFile);
    const d = await dims(out);
    return {
      data: readFileSync(out).toString("base64"),
      mimeType: "image/png",
      note: `side by side: left ${la} = ${input.a}, right ${lb} = ${input.b}, both at ${width}px, first screen → ${d.w}x${d.h} px`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
