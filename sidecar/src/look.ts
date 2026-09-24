import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * "Eyes" for the model: render whatever it just made to a PNG it can look at.
 * Small models write UI/SVG/diagrams blind; seeing the result is most of what
 * separates them from frontier output. Everything runs locally (headless
 * Firefox, rsvg-convert, graphviz, ImageMagick).
 */
export type LookInput = { target: string; width?: number; height?: number };
export type LookResult = { data: string; mimeType: "image/png"; note: string };

const RASTER = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const PAGE = new Set([".html", ".htm", ".xhtml"]);
const MAX_SIDE = 1600;

export const LOOK_DESCRIPTION =
  "Render something visual and look at it: a web page (http://localhost:… dev server URL or an .html file), " +
  ".svg, a Graphviz diagram (.dot/.gv), a Mermaid diagram (.mmd), or an image file. Returns a screenshot you can see. " +
  "Use it after every visual change (UI, CSS, SVG, diagram, generated image) and fix what looks wrong before finishing. " +
  "For Blender/Blockbench scenes use their MCP screenshot tools instead.";

function resolveTarget(target: string, cwd: string): { kind: "url"; url: string } | { kind: "file"; path: string } {
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

export async function look(input: LookInput, cwd: string): Promise<LookResult> {
  const width = Math.min(Math.max(input.width ?? 1280, 200), 2560);
  const height = Math.min(Math.max(input.height ?? 800, 200), 4000);
  const dir = mkdtempSync(join(tmpdir(), "pi-gui-look-"));
  const out = join(dir, "out.png");
  try {
    const t = resolveTarget(input.target, cwd);
    let note: string;
    if (t.kind === "url") {
      await firefoxShot(t.url, out, width, height);
      note = `screenshot of ${t.url} at ${width}x${height}`;
    } else {
      const ext = extname(t.path).toLowerCase();
      if (PAGE.has(ext)) {
        await firefoxShot(pathToFileURL(t.path).href, out, width, height);
        note = `screenshot of ${input.target} at ${width}x${height}`;
      } else if (ext === ".svg") {
        await run("rsvg-convert", ["--width", String(Math.min(width, 1600)), "--keep-aspect-ratio", "--background-color", "white", "-o", out, t.path], { timeout: 30000 });
        note = `render of ${input.target} (white background added)`;
      } else if (ext === ".dot" || ext === ".gv") {
        await run("dot", ["-Tpng", "-Gdpi=110", "-o", out, t.path], { timeout: 30000 });
        note = `graphviz render of ${input.target}`;
      } else if (ext === ".mmd" || ext === ".mermaid") {
        const page = join(dir, "mermaid.html");
        writeFileSync(page, mermaidPage(readFileSync(t.path, "utf8")));
        await firefoxShot(pathToFileURL(page).href, out, width, height);
        note = `mermaid render of ${input.target} (needs network for the mermaid script)`;
      } else if (RASTER.has(ext)) {
        await run("magick", [t.path, "-auto-orient", out], { timeout: 30000 });
        note = `image ${input.target}`;
      } else {
        throw new Error(`don't know how to render ${ext || "this file"} — supported: URL, .html, .svg, .dot/.gv, .mmd, images`);
      }
    }
    // Keep the model's image budget sane.
    await run("magick", [out, "-resize", `${MAX_SIDE}x${MAX_SIDE}>`, out], { timeout: 30000 });
    const { stdout } = await run("magick", ["identify", "-format", "%wx%h", out]);
    return { data: readFileSync(out).toString("base64"), mimeType: "image/png", note: `${note} → ${stdout.trim()} px` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
