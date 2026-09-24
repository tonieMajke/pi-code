import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { countBySeverity, formatAudit, uiAudit } from "./audit.js";
import { closeBrowser } from "./browser.js";

const FIX = fileURLToPath(new URL("./__fixtures__/audit", import.meta.url));

describe("ui_audit", () => {
  afterAll(() => closeBrowser());

  it("finds what a careless page gets wrong", async () => {
    const r = await uiAudit({ target: "bad.html" }, FIX);
    const rules = new Set(r.issues.map((i) => i.rule));
    for (const rule of [
      "default-font",
      "default-link",
      "contrast",
      "placeholder",
      "horizontal-scroll",
      "clipped-text",
      "spacing-scale",
      "control-heights",
      "alignment",
      "card-rows",
      "emoji-icon",
      "text-touches-edge",
    ])
      expect(rules, rule).toContain(rule);
    const grey = r.issues.find((i) => i.rule === "contrast");
    expect(grey?.where).toMatch(/p\.hint/);
    expect(grey?.value).toBeLessThan(2.5);
    expect(r.issues.find((i) => i.rule === "text-touches-edge" && /Glued/.test(i.where))?.detail).toMatch(/0px from the edge of its section\.hero box/);
    expect(formatAudit(r)).toMatch(/Fix every HIGH item/);
  }, 60000);

  it("passes a careful page", async () => {
    const r = await uiAudit({ target: "good.html" }, FIX);
    const c = countBySeverity(r.issues);
    expect(c.high).toBe(0);
    expect(c.medium).toBe(0);
    expect(r.summary.fontFamilies).toEqual(["system-ui"]);
  }, 60000);
});
