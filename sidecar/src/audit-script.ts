/**
 * Runs inside the page (page.evaluate). Plain JS in a string on purpose: tsx/esbuild
 * would inject helpers (__name) into a transpiled function that don't exist in the page.
 *
 * Returns { issues: [{rule, severity, where, detail}], summary }. Contrast comes from
 * CONTRAST_STEP; use auditPage() to run the whole thing.
 */
import type { Page } from "puppeteer-core";
export const AUDIT_SCRIPT = String.raw`(() => {
  const issues = [];
  const add = (rule, severity, el, detail, value) => issues.push({ rule, severity, where: el ? sel(el) : "page", detail, value });

  function sel(el) {
    if (!el || el === document.documentElement) return "html";
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const cls = [...el.classList].filter((c) => c.length < 30).slice(0, 2);
    if (cls.length) s += "." + cls.join(".");
    const t = ownText(el).trim().replace(/\s+/g, " ");
    if (t) s += ' "' + (t.length > 32 ? t.slice(0, 31) + "…" : t) + '"';
    return s;
  }
  function ownText(el) {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return t;
  }
  // Screen-reader-only text (sr-only / visually-hidden) is meant to be invisible.
  function srOnly(el, cs, r) {
    if (r.width <= 2 || r.height <= 2) return true;
    if (cs.clip && cs.clip !== "auto" && /rect\(0/.test(cs.clip)) return true;
    return /inset\((50|100)%/.test(cs.clipPath || "");
  }
  // Opacity multiplies down the tree: text inside a faded-out menu is not on screen.
  function effectiveOpacity(el) {
    let o = 1;
    for (let e = el; e && o > 0.05; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return o;
  }
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.right <= 0 || r.left >= innerWidth) return false; // parked off-canvas (slide-in menus)
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && effectiveOpacity(el) > 0.1 && !srOnly(el, cs, r);
  }
  function rgba(str) {
    const m = /rgba?\(([^)]+)\)/.exec(str || "");
    if (!m) return null;
    const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function over(top, bottom) {
    const a = top.a;
    return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
  }
  function blend(layers) {
    let out = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) out = over(layers[i], out);
    return out;
  }
  function background(el) {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null;
      const c = rgba(cs.backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 1) break;
      }
    }
    return blend(layers);
  }
  function lum(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function contrast(a, b) {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function hex(c) {
    return "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  }
  function hueSat(c) {
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const l = (max + min) / 2;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: (h * 60 + 360) % 360, s, l };
  }

  const all = [...document.body.querySelectorAll("*")].filter((e) => !["SCRIPT", "STYLE", "NOSCRIPT", "BR", "svg", "path"].includes(e.tagName) && !e.closest("svg") && visible(e));
  const W = innerWidth;
  const texts = all.filter((el) => ownText(el).trim());

  // ---- defaults left in
  const bcs = getComputedStyle(document.body);
  if (/times|^serif$|^"?serif"?$/i.test(bcs.fontFamily.split(",")[0].trim())) add("default-font", "high", document.body, "body uses the browser default serif (" + bcs.fontFamily.split(",")[0] + "); set a sans-serif family");
  if (bcs.margin === "8px") add("default-margin", "medium", document.body, "body keeps the browser's default 8px margin");
  const links = texts.filter((e) => e.tagName === "A");
  const plain = links.filter((a) => /^rgb\((0, 0, 238|85, 26, 139)\)$/.test(getComputedStyle(a).color));
  if (plain.length && (plain.length >= 2 || plain.length === links.length)) add("default-link", "high", plain[0], plain.length + " link(s) keep the browser-default blue/purple");

  // Contrast is measured from real pixels afterwards (CONTRAST_STEP, one screenshot per screen).
  window.__piAudit = { texts, done: new Set(), fails: 0, severe: 0, issues: [], sel, rgba, over, contrast, hex };

  // ---- text: size, measure, placeholders
  const sizes = new Map(), families = new Set(), weights = new Set(), textColors = new Set();
  for (const el of texts) {
    const text = ownText(el).trim();
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize);
    sizes.set(Math.round(fs), (sizes.get(Math.round(fs)) || 0) + 1);
    families.add(cs.fontFamily.split(",")[0].replace(/["']/g, "").trim().toLowerCase());
    weights.add(cs.fontWeight);
    const fg = rgba(cs.color);
    if (fg) textColors.add(hex(fg));
    if (fs < 12 && text.length > 2) add("tiny-text", "medium", el, "text " + fs + "px is too small to read comfortably (min 12px)");
    if (/lorem ipsum|dolor sit amet/i.test(text)) add("placeholder", "high", el, "placeholder text left in");
    if (/^(click here|welcome to (my|the) app!?|your text here|title here)$/i.test(text)) add("placeholder", "high", el, "placeholder copy: " + text);
    if (/\p{Extended_Pictographic}/u.test(text) && el.closest("button, nav, h1, h2, h3, h4, [role=button], li")) add("emoji-icon", "low", el, "emoji used as an icon/decoration; use an icon library or nothing");
    const r = el.getBoundingClientRect();
    if (text.length > 200 && r.width / fs > 45) add("line-length", "low", el, "text block " + Math.round(r.width) + "px wide ≈ " + Math.round(r.width / (fs * 0.5)) + " characters per line (keep ≤ ~75)");
    if (cs.textAlign === "center" && text.length > 160 && r.height > fs * 2.6) add("centered-paragraph", "low", el, "multi-line paragraph is centered; left-align body text");
  }

  // ---- spacing off the scale (multiples of 4, plus 1–2px hairlines)
  const offScale = new Map();
  const ok = (v) => v === 0 || v === 1 || v === 2 || (Math.abs(v - Math.round(v / 4) * 4) < 0.26);
  for (const el of all) {
    const cs = getComputedStyle(el);
    const check = (prop, raw) => {
      const v = parseFloat(raw);
      if (!isFinite(v) || v <= 0 || v > 160 || ok(v)) return;
      const key = prop + " " + (Math.round(v * 10) / 10) + "px";
      const e = offScale.get(key) || { n: 0, el };
      e.n++;
      offScale.set(key, e);
    };
    for (const side of ["Top", "Right", "Bottom", "Left"]) check("padding", cs["padding" + side]);
    check("margin-top", cs.marginTop);
    check("margin-bottom", cs.marginBottom);
    // Horizontal margins that are equal on both sides are centering, not spacing.
    if (cs.marginLeft !== cs.marginRight) { check("margin-left", cs.marginLeft); check("margin-right", cs.marginRight); }
    if (/flex|grid/.test(cs.display)) { check("gap", cs.rowGap); check("gap", cs.columnGap); }
  }
  [...offScale.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8)
    .forEach(([k, e]) => add("spacing-scale", "medium", e.el, k + " is off the 4px scale" + (e.n > 1 ? " (" + e.n + " elements)" : "")));

  // ---- text glued to the edge of the coloured/bordered box it sits in (the box may be
  // an ancestor: a hero section with a background and an h1 inside, no padding)
  const surfaceOf = (el) => {
    for (let e = el, i = 0; e && e !== document.body && i < 6; e = e.parentElement, i++) {
      const cs = getComputedStyle(e);
      const bordered = parseFloat(cs.borderLeftWidth) > 0 && (rgba(cs.borderLeftColor) || { a: 0 }).a > 0;
      const bg = rgba(cs.backgroundColor);
      const parentBg = e.parentElement ? background(e.parentElement) : null;
      const filled = bg && bg.a > 0.05 && parentBg && hex(over(bg, parentBg)) !== hex(parentBg);
      const img = cs.backgroundImage && cs.backgroundImage !== "none";
      if (bordered || filled || img) return e;
    }
    return null;
  };
  const glued = new Set();
  for (const el of all) {
    if (!ownText(el).trim() || /inline/.test(getComputedStyle(el).display) && el.tagName !== "SPAN") continue;
    const surf = surfaceOf(el);
    if (!surf || glued.has(surf) || /^(BUTTON|INPUT|SELECT|TEXTAREA|A|LABEL|TD|TH)$/.test(surf.tagName)) continue;
    const r = el.getBoundingClientRect(), b = surf.getBoundingClientRect();
    if (b.width >= W - 2) continue; // full-bleed band: the page gutter is the padding
    const left = r.left - b.left, top = r.top - b.top, right = b.right - r.right;
    const gap = Math.min(left, top, right);
    if (gap < 6 && b.height > r.height + 4) {
      glued.add(surf);
      add("text-touches-edge", "medium", el, "text is " + Math.max(0, Math.round(gap)) + "px from the edge of its " + (surf === el ? "" : sel(surf).split(" ")[0] + " ") + "box (left " + Math.round(left) + ", top " + Math.round(top) + ", right " + Math.round(right) + "); give the box padding 16–32px");
    }
  }

  // ---- alignment: stacked siblings whose left edges almost (but not quite) line up
  const parents = new Set(all.map((e) => e.parentElement).filter(Boolean));
  let alignCount = 0;
  for (const p of parents) {
    const kids = [...p.children].filter((k) => all.includes(k));
    if (kids.length < 2) continue;
    const rects = kids.map((k) => k.getBoundingClientRect());
    for (let i = 1; i < kids.length && alignCount < 6; i++) {
      const a = rects[i - 1], b = rects[i];
      const stacked = b.top >= a.bottom - 1;
      const dx = Math.abs(a.left - b.left);
      if (stacked && dx > 0.5 && dx <= 4) { add("alignment", "medium", kids[i], "left edge " + dx.toFixed(1) + "px off from the sibling above"); alignCount++; }
    }
    // Controls in one row with different heights
    const controls = kids.filter((k) => k.matches("button, a[class*=btn], a[class*=button], input, select, [role=button]"));
    if (controls.length >= 2) {
      const cr = controls.map((k) => k.getBoundingClientRect());
      const sameRow = cr.every((r) => Math.abs(r.top + r.height / 2 - (cr[0].top + cr[0].height / 2)) < cr[0].height);
      const hs = cr.map((r) => Math.round(r.height));
      if (sameRow && Math.max(...hs) - Math.min(...hs) > 2) add("control-heights", "medium", p, "controls in one row have different heights: " + hs.join("/") + "px");
    }
  }

  // ---- repeated cards in a row whose inner blocks don't line up
  for (const p of parents) {
    const kids = [...p.children].filter((k) => all.includes(k) && k.children.length >= 2);
    if (kids.length < 2) continue;
    const sig = (k) => k.tagName + "." + [...k.classList].sort().join(".");
    const groups = new Map();
    for (const k of kids) (groups.get(sig(k)) || groups.set(sig(k), []).get(sig(k))).push(k);
    for (const cards of groups.values()) {
      if (cards.length < 2) continue;
      const tops = cards.map((c) => c.getBoundingClientRect().top);
      const row = cards.filter((c, i) => Math.abs(tops[i] - tops[0]) < 2);
      if (row.length < 2) continue;
      const lastOffsets = row.map((c) => { const l = [...c.children].filter((x) => all.includes(x)).pop(); return l ? l.getBoundingClientRect().top - c.getBoundingClientRect().top : 0; });
      const spread = Math.max(...lastOffsets) - Math.min(...lastOffsets);
      if (spread > 4) { add("card-rows", "medium", row[0], "repeated cards in one row: their last block (e.g. button) sits at different heights (spread " + Math.round(spread) + "px); give variable parts a min-height or use subgrid / margin-top:auto"); break; }
    }
  }

  // ---- overflow and clipping
  const sw = document.scrollingElement.scrollWidth;
  if (sw > W + 1) {
    const culprit = all.filter((e) => e.getBoundingClientRect().right > W + 1).sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
    add("horizontal-scroll", "high", culprit, "page scrolls horizontally at " + W + "px (content " + sw + "px wide)");
  }
  let clipCount = 0;
  for (const el of all) {
    const cs = getComputedStyle(el);
    const own = ownText(el).trim();
    if (clipCount < 5 && /hidden|clip/.test(cs.overflowX) && cs.textOverflow !== "ellipsis" && el.scrollWidth > el.clientWidth + 1 && own.length > 6 && !/^[★☆•·.\s]+$/.test(own)) { add("clipped-text", "high", el, "text is cut off (" + el.scrollWidth + "px content in " + el.clientWidth + "px box)"); clipCount++; }
  }

  // ---- colour budget
  const accents = new Map();
  for (const el of all) {
    const cs = getComputedStyle(el);
    for (const v of [cs.backgroundColor, cs.color, cs.borderTopColor]) {
      const c = rgba(v);
      if (!c || c.a < 0.3) continue;
      const hs = hueSat(c);
      if (hs.s > 0.35 && hs.l > 0.15 && hs.l < 0.85) {
        const bucket = Math.round(hs.h / 30) % 12;
        accents.set(bucket, hex(c));
      }
    }
  }
  const sizeList = [...sizes.keys()].sort((a, b) => a - b);
  if (sizeList.length > 5) add("type-scale", "low", null, sizeList.length + " different font sizes (" + sizeList.join("/") + "px); keep to 3–4");
  if (families.size > 2) add("font-families", "low", null, families.size + " font families: " + [...families].join(", "));
  if (accents.size > 2) add("accent-colors", "low", null, accents.size + " saturated hues in use (" + [...accents.values()].join(" ") + "); one accent plus status colours");

  return {
    issues,
    summary: {
      width: W,
      fontSizes: sizeList,
      fontFamilies: [...families],
      fontWeights: [...weights].sort(),
      textColors: textColors.size,
      accentHues: [...accents.values()],
      elements: all.length,
    },
  };
})()`;


/**
 * Contrast from pixels, not styles: backgrounds come from images, pseudo-elements,
 * clip-paths, blend modes and sibling layers that computed styles can't see. For each
 * text fully on screen and not covered, the background is the most common colour in
 * its box (glyphs cover a minority of it). A busy box (photo) is skipped.
 */
function contrastStep(pngBase64: string): string {
  return String.raw`(async () => {
  const st = window.__piAudit;
  const img = new Image();
  img.src = "data:image/png;base64,` + pngBase64 + String.raw`";
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  const g = cv.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const sx = img.width / innerWidth;
  for (const el of st.texts) {
    if (st.done.has(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth || r.width < 3 || r.height < 3) continue;
    const cx = r.left + Math.min(r.width, 40) / 2, cy = r.top + r.height / 2;
    const top = document.elementFromPoint(cx, cy);
    if (top && !(top === el || el.contains(top) || top.contains(el))) continue; // covered (sticky header, modal) — try next screen
    st.done.add(el);
    const cs = getComputedStyle(el);
    const fg0 = st.rgba(cs.color);
    if (!fg0 || fg0.a === 0) continue;
    const x0 = Math.floor(r.left * sx), y0 = Math.floor(r.top * sx), w = Math.max(1, Math.floor(r.width * sx)), h = Math.max(1, Math.floor(r.height * sx));
    const data = g.getImageData(x0, y0, w, h).data;
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 2500)));
    const buckets = new Map();
    let n = 0;
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4, R = data[i], G = data[i + 1], B = data[i + 2];
      const k = (R >> 4) + "," + (G >> 4) + "," + (B >> 4);
      const e = buckets.get(k) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += R; e.g += G; e.b += B;
      buckets.set(k, e);
      n++;
    }
    let best = null;
    for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
    if (!best || best.n / n < 0.4) continue; // photo or gradient behind the text — can't judge
    const bg = { r: best.r / best.n, g: best.g / best.n, b: best.b / best.n, a: 1 };
    const fg = st.over(fg0, bg);
    const fs = parseFloat(cs.fontSize);
    const ratio = st.contrast(fg, bg);
    const large = fs >= 24 || (fs >= 18.66 && Number(cs.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    if (ratio >= need) continue;
    st.fails++;
    if (ratio < 2.5) st.severe++;
    if (st.fails <= 8) st.issues.push({ rule: "contrast", severity: "high", where: st.sel(el), detail: "contrast " + ratio.toFixed(2) + ":1 (needs " + need + ") — " + st.hex(fg) + " on " + st.hex(bg) + " at " + fs + "px", value: ratio });
  }
  return st.done.size;
})()`;
}

export type RawAudit = {
  issues: { rule: string; severity: "high" | "medium" | "low"; where: string; detail: string; value?: number }[];
  summary: { width: number; fontSizes: number[]; fontFamilies: string[]; fontWeights: string[]; textColors: number; accentHues: string[]; elements: number; contrastFails: number; severeContrast: number };
};

/** Full audit of a loaded page: DOM rules, then contrast screen by screen (max 6), back at the top. */
export async function auditPage(page: Page): Promise<RawAudit> {
  const base = (await page.evaluate(AUDIT_SCRIPT)) as Omit<RawAudit, "summary"> & { summary: Omit<RawAudit["summary"], "contrastFails" | "severeContrast"> };
  const { total, vh } = (await page.evaluate("({ total: document.scrollingElement.scrollHeight, vh: innerHeight })")) as { total: number; vh: number };
  const screens = Math.min(Math.ceil(total / vh), 6);
  for (let s = 0; s < screens; s++) {
    await page.evaluate(`scrollTo(0, ${s * vh})`);
    await new Promise((r) => setTimeout(r, 150));
    const png = (await page.screenshot({ encoding: "base64" })) as string;
    await page.evaluate(contrastStep(png));
  }
  await page.evaluate("scrollTo(0, 0)");
  await new Promise((r) => setTimeout(r, 150));
  const c = (await page.evaluate("({ issues: window.__piAudit.issues, fails: window.__piAudit.fails, severe: window.__piAudit.severe })")) as {
    issues: RawAudit["issues"];
    fails: number;
    severe: number;
  };
  return { issues: [...c.issues, ...base.issues], summary: { ...base.summary, contrastFails: c.fails, severeContrast: c.severe } };
}
