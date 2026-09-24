import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Page } from "puppeteer-core";
import { projectRefs } from "./refs.js";

/**
 * The visual critic: a fresh session with no tools and no history — not the author's
 * reasoning, not earlier verdicts — that sees only the request and pictures. By default
 * it is the same model as the session (most people run one local model); the clean
 * context, the reference and the hard numbers are what keep it from sharing the
 * author's blind spots.
 */
export const CRITIC_SYSTEM_PROMPT =
  "You are an art director with a sharp eye. You review finished visual work from pictures only. " +
  "You are specific, concrete and brief. You never praise, you never rewrite the brief.";

export type CriticInput = {
  task: string;
  /** "ui": a page (reference | work side by side, + phone width). "image": 3D/illustration work. */
  kind: "ui" | "image";
  hasReference: boolean;
  /** Formatted ui_audit report, when the work is a page. */
  audit?: string;
  /** Text mode (model can't see images): a structural outline of the page instead. */
  outline?: string;
};

export function criticPrompt(i: CriticInput): string {
  const pictures = i.outline
    ? "You cannot see images, so you get a structural outline of the rendered page (boxes, sizes, colours) instead."
    : i.hasReference
      ? `Picture 1: LEFT = a reference the author chose as the quality bar, RIGHT = the work.${i.kind === "ui" ? " Picture 2: the work at phone width (390 px)." : ""}`
      : `Picture 1: the work.${i.kind === "ui" ? " Picture 2: the work at phone width (390 px)." : ""}`;
  const judge =
    i.kind === "ui"
      ? "visual hierarchy (one clear primary element), spacing rhythm and alignment, typography (sizes, weights, line length), colour restraint (one accent), contrast, polish of details (borders, radii, icon consistency), how it holds up at phone width"
      : "silhouette and readability at a glance, proportions, shape language (big/medium/small shapes), colour palette and value contrast, materials and surface, level of detail consistency, anything broken (gaps, intersecting parts, stretched textures, floating pieces)";
  return `## The request
${i.task.trim() || "(no request text)"}

## What you get
${pictures}
${i.audit ? `\n## Measured problems (from the rendered DOM — facts, not opinions)\n${i.audit}\n` : ""}${i.outline ? `\n## Page outline\n${i.outline}\n` : ""}
## Your job
Name at most 5 concrete, visible problems that make the work look worse than ${i.hasReference ? "the reference" : "a careful professional would accept"}.
Judge quality, not sameness: do not ask for the reference's layout, content or subject details — only for its level of craft.
Look at: ${judge}.
For each problem: where it is, what is wrong, the fix — with numbers when you can (px, hex colours, sizes, ratios).
${i.audit ? "Measured HIGH problems that are still present count as problems.\n" : ""}Severity bar: report only what a senior designer would fix before shipping — problems visible at a glance.
Nitpicks (1–2 px, a slightly different shade, personal taste) do not count. Solid work gets OK; that is the expected answer once the big problems are gone.
No scores, no praise, no summary.
If there is nothing concrete left to fix, write only the verdict line.
End with exactly one of these lines:
VERDICT: OK
VERDICT: ISSUES
If ISSUES, list each problem above that line as "- <where>: <problem> → <fix>".`;
}

export function criticNudge(issues: string, round: number, maxRounds: number): string {
  return (
    `[Art direction review, round ${round}/${maxRounds}]\nA reviewer with fresh eyes compared your result with the reference and found:\n${issues}\n\n` +
    "Fix these (the ones you agree with — if you disagree with one, say why in one line), then look at the result again and run ui_audit if it is a page."
  );
}

/**
 * The reference to hold the work against: a file named in the newest brief.md
 * ("References I liked …"), else the newest topic's first picture.
 */
export function pickReference(cwd: string): string | null {
  const refs = projectRefs(cwd);
  if (!refs.length) return null;
  const brief = join(dirname(refs[0]), "brief.md");
  if (existsSync(brief)) {
    const text = readFileSync(brief, "utf8");
    const liked = refs.filter((r) => dirname(r) === dirname(refs[0])).find((r) => text.includes(basename(r)));
    if (liked) return liked;
  }
  return refs[0];
}

/** Structural outline of a page for a critic without vision: blocks, text, sizes, colours. */
export const OUTLINE_SCRIPT = String.raw`(() => {
  const lines = [];
  const walk = (el, depth) => {
    if (lines.length >= 120 || depth > 7) return;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
    const bg = cs.backgroundColor !== "rgba(0, 0, 0, 0)" ? " bg " + cs.backgroundColor : "";
    const border = parseFloat(cs.borderTopWidth) > 0 ? " border " + cs.borderTopWidth + " " + cs.borderTopColor : "";
    const radius = parseFloat(cs.borderTopLeftRadius) > 0 ? " radius " + cs.borderTopLeftRadius : "";
    const pad = cs.padding !== "0px" ? " pad " + cs.padding : "";
    const text = own ? ' "' + own.slice(0, 50) + '" ' + cs.fontSize + "/" + cs.fontWeight + " " + cs.color : "";
    const box = Math.round(r.left) + "," + Math.round(r.top) + " " + Math.round(r.width) + "x" + Math.round(r.height);
    if (own || bg || border || ["BUTTON", "INPUT", "IMG", "SECTION", "HEADER", "NAV", "MAIN", "FOOTER"].includes(el.tagName))
      lines.push("  ".repeat(depth) + el.tagName.toLowerCase() + " " + box + bg + border + radius + pad + text);
    for (const c of el.children) walk(c, depth + 1);
  };
  walk(document.body, 0);
  return lines.join("\n");
})()`;

export async function pageOutline(page: Page): Promise<string> {
  return (await page.evaluate(OUTLINE_SCRIPT)) as string;
}
