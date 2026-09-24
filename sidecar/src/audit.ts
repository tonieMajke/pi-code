import { pathToFileURL } from "node:url";
import { auditPage } from "./audit-script.js";
import { open, withPage } from "./browser.js";
import { resolveTarget } from "./look.js";

/**
 * ui_audit: hard measurements from the rendered DOM. A small model's vision can't
 * tell 13px from 16px or 3.9:1 from 4.5:1 — numbers it can't miss can.
 */
export type Severity = "high" | "medium" | "low";
export type AuditIssue = { rule: string; severity: Severity; where: string; detail: string; value?: number; width?: number };
export type AuditSummary = {
  width: number;
  fontSizes: number[];
  fontFamilies: string[];
  fontWeights: string[];
  textColors: number;
  accentHues: string[];
  elements: number;
  /** All texts below WCAG, and those below 2.5:1 (only the first 8 are listed as issues). */
  contrastFails: number;
  severeContrast: number;
};
export type AuditReport = { target: string; issues: AuditIssue[]; summary: AuditSummary };

export const AUDIT_DESCRIPTION =
  "Measure a rendered page (dev-server URL or .html file) for objective UI problems your eyes miss: " +
  "text contrast below WCAG, spacing off the 4px scale, almost-aligned edges, buttons of different heights in a row, " +
  "repeated cards whose rows don't line up, horizontal scroll or clipped text at phone width, browser-default styles, " +
  "placeholder text, too many font sizes or accent colours. Checks desktop and 390px widths. Fix every high item.";

/** Rules that only mean something at phone width. */
const NARROW_RULES = new Set(["horizontal-scroll", "clipped-text", "tiny-text", "control-heights", "text-touches-edge"]);
const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const MAX_ISSUES = 30;

export async function uiAudit(input: { target: string; width?: number; narrow?: boolean }, cwd: string): Promise<AuditReport> {
  const t = resolveTarget(input.target, cwd);
  const url = t.kind === "url" ? t.url : pathToFileURL(t.path).href;
  const width = Math.min(Math.max(input.width ?? 1280, 320), 2560);
  const run = (w: number) =>
    withPage({ width: w, height: 900 }, async (page) => {
      await open(page, url, 300);
      return (await auditPage(page)) as { issues: AuditIssue[]; summary: AuditSummary };
    });
  const wide = await run(width);
  const issues = [...wide.issues];
  if (input.narrow !== false && width > 400) {
    const narrow = await run(390);
    for (const i of narrow.issues) {
      if (!NARROW_RULES.has(i.rule)) continue;
      if (issues.some((x) => x.rule === i.rule && x.where === i.where)) continue;
      issues.push({ ...i, width: 390 });
    }
  }
  issues.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  return { target: input.target, issues: issues.slice(0, MAX_ISSUES), summary: wide.summary };
}

export function countBySeverity(issues: AuditIssue[]): Record<Severity, number> {
  const c = { high: 0, medium: 0, low: 0 };
  for (const i of issues) c[i.severity]++;
  return c;
}

export function formatAudit(r: AuditReport): string {
  const c = countBySeverity(r.issues);
  const s = r.summary;
  const lines = [
    `ui_audit ${r.target} @${s.width}px (+390px): ${c.high} high, ${c.medium} medium, ${c.low} low`,
    `Measured: font sizes ${s.fontSizes.join("/")}px · families ${s.fontFamilies.join(", ") || "-"} · weights ${s.fontWeights.join("/")} · ` +
      `${s.textColors} text colours · saturated hues ${s.accentHues.join(" ") || "none"}` +
      (s.contrastFails > 8 ? ` · ${s.contrastFails} texts fail contrast in total` : ""),
  ];
  for (const sev of ["high", "medium", "low"] as const) {
    const list = r.issues.filter((i) => i.severity === sev);
    if (!list.length) continue;
    lines.push("", sev.toUpperCase());
    for (const i of list) lines.push(`- [${i.rule}]${i.width ? ` @${i.width}px` : ""} ${i.where}: ${i.detail}`);
  }
  if (!r.issues.length) lines.push("", "No measurable problems. (This does not judge taste — still compare with the reference.)");
  else if (c.high) lines.push("", "Fix every HIGH item, then the MEDIUM ones, and run ui_audit again. If one is intentional, say why.");
  return lines.join("\n");
}
