import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE, effectiveTheme, luminance, mix, themeVars } from "./appearance";

const a = (over: Partial<typeof DEFAULT_APPEARANCE>) => ({ ...DEFAULT_APPEARANCE, ...over });

describe("appearance", () => {
  it("mix interpolates per channel", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#262624", "#000000", 0)).toBe("#262624");
  });

  it("luminance orders black < grey < white", () => {
    expect(luminance("#000000")).toBe(0);
    expect(luminance("#ffffff")).toBeCloseTo(1);
    expect(luminance("#808080")).toBeGreaterThan(0.1);
  });

  it("theme: explicit choice, system follows the OS", () => {
    expect(effectiveTheme(a({ theme: "light" }), false)).toBe("light");
    expect(effectiveTheme(a({ theme: "system" }), true)).toBe("light");
    expect(effectiveTheme(a({ theme: "system" }), false)).toBe("dark");
  });

  it("a custom background overrides the theme so text stays readable", () => {
    expect(effectiveTheme(a({ theme: "dark", background: "#f4f1ea" }), false)).toBe("light");
    expect(effectiveTheme(a({ theme: "light", background: "#1b1d23" }), true)).toBe("dark");
  });

  it("defaults set no overrides", () => {
    expect(themeVars(DEFAULT_APPEARANCE, "dark")).toEqual({});
  });

  it("background derives the surfaces: darker side panel, lighter cards in dark theme", () => {
    const v = themeVars(a({ background: "#262624" }), "dark");
    expect(v["--bg"]).toBe("#262624");
    expect(luminance(v["--bg-side"])).toBeLessThan(luminance("#262624"));
    expect(luminance(v["--surface"])).toBeGreaterThan(luminance("#262624"));
  });

  it("accent derives hover and a soft translucent tint", () => {
    const v = themeVars(a({ accent: "#5b8def" }), "dark");
    expect(v["--accent"]).toBe("#5b8def");
    expect(v["--accent-soft"]).toBe("rgba(91, 141, 239, 0.14)");
    expect(luminance(v["--accent-hover"])).toBeGreaterThan(luminance("#5b8def"));
  });
});
