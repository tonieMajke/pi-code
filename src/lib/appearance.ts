import type { Appearance } from "../../shared/protocol";

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "system",
  accent: null,
  background: null,
  image: { dim: 0.55, blur: 0 },
  imageUrl: null,
};

/** Accent presets (first = the built-in terracotta). */
export const ACCENTS = ["#d97757", "#e0a340", "#7fb069", "#4fa3a5", "#5b8def", "#9b7be0", "#d4679a", "#9b998f"];
/** Background presets: three dark, three light. */
export const BACKGROUNDS = ["#1b1d23", "#1e2420", "#2a2230", "#f4f1ea", "#eef2f6", "#f6eef0"];

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/** `a` moved toward `b` by `t` (0..1). */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return hex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as Rgb);
}

/** WCAG relative luminance, 0 (black) .. 1 (white). */
export function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A custom background decides light/dark itself — otherwise the text could vanish. */
export function effectiveTheme(a: Appearance, systemLight: boolean): "dark" | "light" {
  if (a.background) return luminance(a.background) > 0.4 ? "light" : "dark";
  if (a.theme === "system") return systemLight ? "light" : "dark";
  return a.theme;
}

/** CSS custom properties that override the theme defaults in styles.css. */
export function themeVars(a: Appearance, theme: "dark" | "light"): Record<string, string> {
  const v: Record<string, string> = {};
  const dark = theme === "dark";
  if (a.background) {
    const bg = a.background;
    v["--bg"] = bg;
    v["--bg-side"] = mix(bg, "#000000", dark ? 0.18 : 0.04);
    v["--surface"] = dark ? mix(bg, "#ffffff", 0.06) : mix(bg, "#ffffff", 0.75);
    v["--surface-2"] = dark ? mix(bg, "#ffffff", 0.1) : mix(bg, "#000000", 0.03);
    v["--bubble"] = mix(bg, "#000000", dark ? 0.47 : 0.04);
    v["--code-bg"] = mix(bg, "#000000", dark ? 0.27 : 0.03);
  }
  if (a.accent) {
    v["--accent"] = a.accent;
    v["--accent-hover"] = dark ? mix(a.accent, "#ffffff", 0.12) : mix(a.accent, "#000000", 0.1);
    const [r, g, b] = rgb(a.accent);
    v["--accent-soft"] = `rgba(${r}, ${g}, ${b}, ${dark ? 0.14 : 0.12})`;
  }
  return v;
}

const VARS = ["--bg", "--bg-side", "--surface", "--surface-2", "--bubble", "--code-bg", "--accent", "--accent-hover", "--accent-soft"];
const CACHE_KEY = "pi-gui.appearance";

/** Put the look on <html>. Safe to call repeatedly; system theme changes are handled by CSS. */
export function applyAppearance(a: Appearance): void {
  const root = document.documentElement;
  const systemLight = window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;
  const theme = effectiveTheme(a, systemLight);
  // "system" without a custom background: leave it to the media query so it follows live.
  if (a.theme === "system" && !a.background) delete root.dataset.theme;
  else root.dataset.theme = theme;
  const vars = themeVars(a, theme);
  for (const name of VARS) {
    if (vars[name]) root.style.setProperty(name, vars[name]);
    else root.style.removeProperty(name);
  }
  root.classList.toggle("has-bg-image", !!a.imageUrl);
  root.style.setProperty("--bg-dim", String(a.image.dim));
  root.style.setProperty("--bg-blur", `${a.image.blur}px`);
  try {
    // Colours only (the picture is too big): avoids a flash of the default theme on start.
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...a, imageUrl: null }));
  } catch {
    /* storage unavailable */
  }
}

export function cachedAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) return { ...DEFAULT_APPEARANCE, ...(JSON.parse(raw) as Partial<Appearance>), imageUrl: null };
  } catch {
    /* ignore */
  }
  return DEFAULT_APPEARANCE;
}

/** Decode a picked file and re-encode it as a JPEG data URL, longest side ≤ maxSide. */
export async function downscaleImage(file: File, maxSide = 2560): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.88);
  } finally {
    URL.revokeObjectURL(url);
  }
}
