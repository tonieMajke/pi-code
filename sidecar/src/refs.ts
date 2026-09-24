import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "puppeteer-core";
import { auditPage } from "./audit-script.js";
import { open, withPage } from "./browser.js";
import { fontArgs } from "./look.js";

const run = promisify(execFile);

/**
 * design_refs: inspiration as pictures the model can compare against. Descriptions
 * ("minimal, airy") don't transfer to a small model; screenshots do.
 *
 * No fixed list of "good sites" — that would make every project look the same.
 * Candidates come from a web search for *this* task (direct hits plus the sites that
 * "best … websites" roundups link to), are shuffled so every run differs, and must
 * pass a quality gate (the same measurements as ui_audit) to count. The user's local
 * gallery (~/.pi/agent/design-refs) fills in when the web gives too little.
 * Everything lands in <project>/.pi/design-refs/<topic>/ so later screens reuse it.
 */
export const DESIGN_REFS_DESCRIPTION =
  "Find references BEFORE making something visual, to compare your work against. kind \"ui\": real websites/apps like the one " +
  "you are building, screenshotted and quality-checked. kind \"image\": pictures of any subject — a character or prop for a " +
  "Blender/Blockbench model, an object for an SVG illustration. `query` must be specific: \"artisan bakery website\", " +
  "\"kanban board app for small teams\", \"stylized goblin 3d character\", \"low poly medieval windmill\" — not \"landing page\" or \"goblin\" alone. " +
  "`urls` uses exactly those pages/images. Results vary on every call. Saves to .pi/design-refs/<topic>/, shows them to you; " +
  "then pick what you like, write brief.md there and build to it.";

export const BRIEF_TEMPLATE = `# Brief: <topic>
References I liked and why: <file — what makes it look good>

## Traits to take (measured from the references, not invented)
- Mood in 3 words: __ (e.g. warm, editorial, calm)
- Density: section padding __px, gap between list items __px, card padding __px
- Type: sizes __/__/__px, weights __/__, line height __, font family kind (serif / humanist sans / geometric / mono)
- Colour: background __, surface __, border __, text __, muted text __, ONE accent __ (used only for __)
- Shape: radius __px; borders vs shadows: __
- Imagery / icons: __
- Primary element of the screen: __
- What the references do NOT do: (e.g. no gradients, no emoji, no borders around every block)

## Tokens (copy into CSS variables)
--space: 4 8 12 16 24 32 48; --radius: __; --text: __; --muted: __; --border: __; --accent: __`;

const MAX_REFS = 4;
/** Screenshot attempts per call — each costs ~3 s. */
const MAX_ATTEMPTS = 10;
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

/** Not a design to learn from: social, forums, marketplaces, code hosts, template shops, concept-shot galleries. */
export const BLOCKED_DOMAINS = [
  "wikipedia.org", "youtube.com", "reddit.com", "pinterest.com", "facebook.com", "instagram.com", "x.com", "twitter.com",
  "linkedin.com", "tiktok.com", "medium.com", "quora.com", "stackoverflow.com", "stackexchange.com", "amazon.com",
  "ebay.com", "etsy.com", "github.com", "gitlab.com", "npmjs.com", "duckduckgo.com", "google.com", "bing.com",
  "themeforest.net", "templatemonster.com", "envato.com", "wix.com", "squarespace.com", "webflow.com", "framer.com",
  "dribbble.com", "behance.net", "awwwards.com", "canva.com", "freepik.com", "shutterstock.com", "yelp.com",
  "tripadvisor.com", "apple.com", "play.google.com", "t.co", "bit.ly",
];

export function topicSlug(topic: string): string {
  return (
    topic
      .toLowerCase()
      .replace(/ł/g, "l") // the one Polish letter NFKD doesn't decompose
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "ui"
  );
}

export function refsRoot(cwd: string): string {
  return join(cwd, ".pi", "design-refs");
}

/** Does the project already have reference images (any topic)? */
export function hasRefs(cwd: string): boolean {
  const root = refsRoot(cwd);
  if (!existsSync(root)) return false;
  return readdirSync(root).some((d) => {
    const dir = join(root, d);
    return statSync(dir).isDirectory() && readdirSync(dir).some((f) => /\.(png|jpe?g|webp)$/i.test(f));
  });
}

/** Reference images of the project, newest topic first (for the critic). */
export function projectRefs(cwd: string): string[] {
  const root = refsRoot(cwd);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((d) => join(root, d))
    .filter((d) => statSync(d).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .flatMap((d) => readdirSync(d).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort().map((f) => join(d, f)));
}

/** Domains already used as references anywhere in the project — skipped, so runs bring new ideas. */
function usedDomains(cwd: string): Set<string> {
  const root = refsRoot(cwd);
  const out = new Set<string>();
  if (!existsSync(root)) return out;
  for (const d of readdirSync(root)) {
    const f = join(root, d, "sources.json");
    if (!existsSync(f)) continue;
    try {
      for (const s of JSON.parse(readFileSync(f, "utf8")) as { url?: string }[]) if (s.url) out.add(host(s.url));
    } catch {
      /* ignore */
    }
  }
  return out;
}

// ---------------------------------------------------------------- search

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function blocked(url: string): boolean {
  const h = host(url);
  if (!h || !/^https?:/.test(url)) return true;
  return BLOCKED_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Roundup articles ("25 best bakery websites") — mined for links, never used as references themselves. */
function isRoundup(url: string): boolean {
  const path = new URL(url).pathname.toLowerCase();
  return (
    /\/(wp|blog|articles?|posts?|p|inspiration|examples?|showcase|gallery|collections?|templates?|themes?|community|shots?|design)\//.test(path) ||
    /\b(best|top-?\d*|examples|inspiration|ideas|websites|templates?)\b/.test(path.replace(/[-_/]/g, " "))
  );
}

async function ddg(query: string): Promise<string[]> {
  const u = new URL("https://html.duckduckgo.com/html/");
  u.searchParams.set("q", query);
  const res = await fetch(u, { headers: { Accept: "text/html", "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);
  const html = await res.text();
  const out: string[] = [];
  for (const m of html.matchAll(/class="result__a"[^>]*href="([^"]+)"/g)) {
    try {
      const l = new URL(m[1].replace(/&amp;/g, "&"), u);
      out.push(l.searchParams.get("uddg") ?? l.href);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** External site links from a roundup article: the sites it recommends. */
async function linksFromRoundup(url: string): Promise<string[]> {
  const res = await fetch(url, { headers: { Accept: "text/html", "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return [];
  const html = await res.text();
  const self = host(url);
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\s[^>]*href="(https?:\/\/[^"#]+)"/gi)) {
    const link = m[1].replace(/&amp;/g, "&");
    const h = host(link);
    if (!h || h === self || h.endsWith(`.${self}`) || blocked(link)) continue;
    // Sites, not deep links into articles or assets.
    try {
      const p = new URL(link).pathname;
      if (p.split("/").filter(Boolean).length > 1 || /\.(png|jpe?g|gif|svg|pdf|zip)$/i.test(p)) continue;
    } catch {
      continue;
    }
    out.add(`https://${new URL(link).hostname}/`);
  }
  return [...out];
}

function shuffle<T>(a: T[]): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

/**
 * Candidate pages for a query, one per site, shuffled: direct results plus sites
 * recommended by roundup articles. `avoid` = domains already used in this project.
 */
export async function searchPages(query: string, avoid: Set<string> = new Set()): Promise<string[]> {
  const direct: string[] = [];
  const roundups: string[] = [];
  const settled = await Promise.allSettled([ddg(query), ddg(`${query} website`), ddg(`best ${query} website design examples`)]);
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const url of r.value) {
      if (blocked(url)) continue;
      (isRoundup(url) ? roundups : direct).push(url);
    }
  }
  if (settled.every((r) => r.status === "rejected")) throw (settled[0] as PromiseRejectedResult).reason;
  const mined = (await Promise.allSettled(roundups.slice(0, 3).map(linksFromRoundup))).flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const seen = new Set<string>(avoid);
  const out: string[] = [];
  // Interleave the two sources so neither dominates, then shuffle within the pool.
  for (const url of shuffle([...shuffle(direct).slice(0, 8), ...shuffle(mined).slice(0, 12)])) {
    const h = host(url);
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(url);
  }
  return out;
}

// ---------------------------------------------------------------- capture

/**
 * Cookie/consent banners: only ever refuse (never accept on the user's behalf),
 * then hide whatever consent overlay is left.
 */
const DISMISS_SCRIPT = String.raw`(() => {
  const refuse = /^(reject( all)?|decline( all)?|deny|only (necessary|essential)|necessary only|use necessary cookies only|refuse|no,? thanks|not now|maybe later|odrzuć( wszystkie)?|tylko niezbędne|nie, dziękuję|close|×|✕)$/i;
  let clicked = 0;
  for (const b of document.querySelectorAll("button, [role=button], a")) {
    const t = (b.innerText || "").trim() || (b.getAttribute("aria-label") || "").trim();
    if (t.length < 40 && (refuse.test(t) || /^(close|dismiss|zamknij)\b/i.test(b.getAttribute("aria-label") || ""))) { b.click(); clicked++; }
  }
  // Whatever is still floating over the page: consent banners, newsletter/discount pop-ups
  // and their backdrops. Hidden, never answered.
  let hidden = 0;
  const vw = innerWidth, vh = innerHeight;
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") continue;
    const t = (el.innerText || "").slice(0, 800);
    const r = el.getBoundingClientRect();
    const consent = /cookie|consent|privacy|gdpr|zgod/i.test(t) || /cookie|consent|gdpr|onetrust|didomi|cmp/i.test(el.id + " " + el.className);
    const popup = cs.position === "fixed" && (/newsletter|subscribe|sign up|e-?mail|% off|discount|join our/i.test(t) || /modal|popup|overlay|backdrop|klaviyo|dialog/i.test(el.id + " " + el.className)) && r.width * r.height > vw * vh * 0.08 && !el.querySelector("nav");
    if (consent || popup) { el.style.setProperty("display", "none", "important"); hidden++; }
  }
  document.documentElement.style.setProperty("overflow", "auto", "important");
  document.body.style.setProperty("overflow", "auto", "important");
  return { clicked, hidden };
})()`;

/** Why a capture is useless, or null. Measured after dismissing banners. */
const REJECT_SCRIPT = String.raw`(() => {
  const vw = innerWidth, vh = innerHeight;
  const pw = [...document.querySelectorAll("input[type=password]")].some((i) => i.getBoundingClientRect().width > 0);
  const text = (document.body.innerText || "").trim().length;
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed") continue;
    const r = el.getBoundingClientRect();
    const bg = cs.backgroundColor;
    const seen = cs.visibility !== "hidden" && Number(cs.opacity) > 0.1 && cs.pointerEvents !== "none" && !/rgba\(0, 0, 0, 0\)|\/ 0\)$/.test(bg);
    if (seen && r.width * r.height > vw * vh * 0.5 && !el.contains(document.querySelector("main"))) return "a full-screen overlay covers the page";
  }
  if (text < 400 && /\b404\b|not found|could not be found/i.test(document.title + " " + document.body.innerText)) return "page not found (404)";
  const external = new Set([...document.querySelectorAll("main a[href^=http], article a[href^=http]")].map((a) => { try { return new URL(a.href).hostname; } catch { return ""; } }).filter((h) => h && h !== location.hostname && !/facebook|twitter|instagram|linkedin|youtube|pinterest|tiktok|x\.com/.test(h)));
  if (external.size > 15) return "a list of other sites (roundup), not a design";
  let firstScreen = 0;
  for (const el of document.querySelectorAll("body *")) {
    if (!el.childNodes.length || [...el.childNodes].every((n) => n.nodeType !== 3)) continue;
    const r = el.getBoundingClientRect();
    if (r.top >= 0 && r.top < vh && r.width > 2) firstScreen += [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("").length;
  }
  if (firstScreen < 30) return "first screen is only a picture — nothing to learn about the UI";
  return { pw, text };
})()`;

async function blank(file: string): Promise<boolean> {
  const { stdout } = await run("magick", [file, "-colorspace", "gray", "-format", "%[fx:standard_deviation]", "info:"]);
  return Number(stdout.trim()) < 0.015;
}

export type Captured = { file: string; url: string; source: "search" | "given" | "gallery" | "user" };
export type Rejected = { url: string; why: string };

type AuditOut = { issues: { rule: string; severity: string }[]; summary: { elements: number; severeContrast: number } };

/**
 * The taste gate: a candidate only becomes a reference if a careful designer would
 * not be embarrassed by it — measured, not guessed. Real sites often miss WCAG by a
 * little (brand orange buttons), so only clearly unreadable text counts here.
 * Returns why it failed, or null.
 */
export function qualityProblem(a: AuditOut): string | null {
  const rules = new Set(a.issues.map((i) => i.rule));
  for (const r of ["default-font", "default-link", "placeholder", "horizontal-scroll"]) if (rules.has(r)) return `quality: ${r}`;
  if (a.summary.severeContrast >= 3) return `quality: ${a.summary.severeContrast} texts are hard to read (contrast < 2.5:1)`;
  const high = a.issues.filter((i) => i.severity === "high" && i.rule !== "contrast").length;
  if (high >= 3) return `quality: ${high} serious problems`;
  if (a.summary.elements < 25) return "quality: almost empty page";
  return null;
}

async function capture(page: Page, url: string, file: string, wantsLogin: boolean): Promise<string | null> {
  await open(page, url, 1200);
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.evaluate(DISMISS_SCRIPT).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 400));
  const check = (await page.evaluate(REJECT_SCRIPT)) as string | { pw: boolean; text: number };
  if (typeof check === "string") return check;
  // A login wall is only fine when a login screen is what we are making.
  if (check.pw && !wantsLogin) return "login wall";
  if (check.text < 40) return "almost no text (still loading or blocked)";
  const q = qualityProblem(await auditPage(page));
  if (q) return q;
  // The audit scrolled through the page, which triggers lazy images; wait for the ones on screen.
  await page
    .evaluate(`Promise.race([
      Promise.all([...document.images].filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && !i.complete; })
        .map((i) => new Promise((ok) => { i.addEventListener("load", ok, { once: true }); i.addEventListener("error", ok, { once: true }); }))),
      new Promise((ok) => setTimeout(ok, 2500)),
    ]).then(() => new Promise((ok) => setTimeout(ok, 400)))`)
    .catch(() => undefined);
  await page.screenshot({ path: file as `${string}.png` });
  if (await blank(file)) {
    rmSync(file, { force: true });
    return "screenshot is blank (content fades in or failed to load)";
  }
  return null;
}

// ---------------------------------------------------------------- gallery

/** The user's own favourites; PI_GUI_GALLERY overrides (tests). */
const galleryDir = () => process.env.PI_GUI_GALLERY ?? join(homedir(), ".pi", "agent", "design-refs");

function galleryImages(): string[] {
  const GALLERY = galleryDir();
  if (!existsSync(GALLERY)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(png|jpe?g|webp)$/i.test(f)) out.push(p);
    }
  };
  walk(GALLERY);
  return out;
}

/** Gallery pictures whose path mentions the query's words; ties broken at random (variety). */
export function pickFromGallery(query: string, n = MAX_REFS): string[] {
  const words = topicSlug(query).split("-").filter((w) => w.length > 2);
  return shuffle(galleryImages())
    .map((p) => ({ p, s: words.filter((w) => p.toLowerCase().includes(w)).length }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((x) => x.p);
}

// ---------------------------------------------------------------- images

/**
 * Anything that isn't a web page: a goblin for a Blender/Blockbench model, a mill for an
 * SVG illustration, a sword for a game item. Pictures from an image search, filtered
 * for size, watermarks and near-duplicates, shuffled for variety.
 */
const STOCK = [
  "shutterstock.com", "alamy.com", "dreamstime.com", "istockphoto.com", "gettyimages.com", "depositphotos.com", "123rf.com",
  "stock.adobe.com", "ftcdn.net", "vectorstock.com", "canstockphoto.com", "bigstockphoto.com", "freepik.com", "pond5.com", "agefotostock.com",
];
type ImageHit = { image: string; page: string; width: number; height: number; title: string };

function hostIn(url: string, list: string[]): boolean {
  const h = host(url);
  return list.some((d) => h === d || h.endsWith(`.${d}`));
}

async function duckImages(query: string): Promise<ImageHit[]> {
  const page = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
  const vqd = /vqd=["']?([\d-]+)/.exec(await page.text())?.[1];
  if (!vqd) throw new Error("image search: no token");
  const res = await fetch(`https://duckduckgo.com/i.js?l=wt-wt&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,,,&p=1`, {
    headers: { "User-Agent": UA, Referer: "https://duckduckgo.com/", Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`image search HTTP ${res.status}`);
  const j = (await res.json()) as { results?: { image: string; url: string; width: number; height: number; title: string }[] };
  return (j.results ?? []).map((r) => ({ image: r.image, page: r.url, width: r.width, height: r.height, title: r.title }));
}

/** Openverse: openly licensed images, no key — the fallback when the main search fails. */
async function openverse(query: string): Promise<ImageHit[]> {
  const res = await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=30`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`openverse HTTP ${res.status}`);
  const j = (await res.json()) as { results?: { url: string; foreign_landing_url: string; width: number; height: number; title: string }[] };
  return (j.results ?? []).map((r) => ({ image: r.url, page: r.foreign_landing_url, width: r.width ?? 0, height: r.height ?? 0, title: r.title ?? "" }));
}

/** Candidate images: big enough, sane shape, no stock watermarks, one per site, shuffled. */
export function pickImages(hits: ImageHit[]): ImageHit[] {
  const seen = new Set<string>();
  const out: ImageHit[] = [];
  for (const h of shuffle(hits.slice(0, 50))) {
    if (!/^https?:/.test(h.image) || hostIn(h.image, STOCK) || hostIn(h.page, STOCK)) continue;
    if (h.width && h.height && (Math.min(h.width, h.height) < 400 || h.width / h.height > 2.6 || h.height / h.width > 2.6)) continue;
    const site = host(h.page) || host(h.image);
    if (seen.has(site)) continue;
    seen.add(site);
    out.push(h);
  }
  return out;
}

/** 8×8 average hash — near-identical pictures (same render on two sites) count once. */
async function ahash(file: string): Promise<string> {
  const { stdout } = await run("magick", [file, "-resize", "8x8!", "-colorspace", "gray", "-depth", "8", "gray:-"], { encoding: "buffer", timeout: 20_000 });
  const px = [...(stdout as unknown as Buffer)];
  const avg = px.reduce((a, b) => a + b, 0) / px.length;
  return px.map((p) => (p > avg ? "1" : "0")).join("");
}

function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

async function downloadImage(hit: ImageHit, out: string): Promise<string | null> {
  const res = await fetch(hit.image, { headers: { "User-Agent": UA, Referer: hit.page || hit.image }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return `HTTP ${res.status}`;
  const type = res.headers.get("content-type") ?? "";
  // Many CDNs send images as octet-stream; ImageMagick decides below.
  if (/^(text|application\/(json|xml|xhtml))/.test(type)) return `not an image (${type})`;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 12_000_000) return "file too big";
  const raw = `${out}.src`;
  writeFileSync(raw, buf);
  try {
    // First frame, flattened on white, max 1280 px — what the model sees.
    await run("magick", [`${raw}[0]`, "-auto-orient", "-background", "white", "-flatten", "-resize", "1280x1280>", out], { timeout: 30_000 });
  } catch {
    return "unreadable image";
  } finally {
    rmSync(raw, { force: true });
  }
  const { stdout } = await run("magick", ["identify", "-format", "%w %h", out]);
  const [w, h] = stdout.trim().split(" ").map(Number);
  if (Math.min(w, h) < 300) return `too small (${w}x${h})`;
  if (await blank(out)) return "blank image";
  return null;
}

async function collectImages(query: string, given: string[] | undefined, dir: string, captured: Captured[], rejected: Rejected[], next: () => number): Promise<void> {
  let hits: ImageHit[];
  if (given?.length) hits = given.map((image) => ({ image, page: image, width: 0, height: 0, title: "" }));
  else {
    hits = await duckImages(query).catch(async (err: unknown) => {
      rejected.push({ url: "(image search)", why: err instanceof Error ? err.message : String(err) });
      return openverse(query).catch(() => []);
    });
    hits = pickImages(hits);
  }
  const hashes: string[] = [];
  let i = 0;
  const worker = async () => {
    while (i < Math.min(hits.length, MAX_ATTEMPTS + 2) && captured.length < MAX_REFS) {
      const hit = hits[i++];
      const tmp = join(dir, `.img-${i}.png`);
      try {
        const why = await downloadImage(hit, tmp);
        if (why) {
          rejected.push({ url: hit.image, why });
          rmSync(tmp, { force: true });
          continue;
        }
        const hsh = await ahash(tmp);
        if (hashes.some((x) => hamming(x, hsh) <= 6)) {
          rejected.push({ url: hit.image, why: "near-duplicate of another reference" });
          rmSync(tmp, { force: true });
          continue;
        }
        if (captured.length >= MAX_REFS) {
          rmSync(tmp, { force: true });
          continue;
        }
        hashes.push(hsh);
        const file = join(dir, `${String(next()).padStart(2, "0")}-${topicSlug(`${host(hit.page) || host(hit.image)} ${hit.title}`).slice(0, 48)}.png`);
        renameSync(tmp, file);
        captured.push({ file, url: hit.page || hit.image, source: given?.length ? "given" : "search" });
      } catch (err) {
        rmSync(tmp, { force: true });
        rejected.push({ url: hit.image, why: err instanceof Error ? err.message.split("\n")[0] : String(err) });
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

export const IMAGE_BRIEF_TEMPLATE = `# Brief: <topic>
References I liked and why: <file — what makes it read well>

## Traits to take (observed in the references, not invented)
- Silhouette: what makes it recognisable from far away (e.g. big ears, hunched back, long nose)
- Proportions: head : body : legs ≈ __ : __ : __; hands/feet size; stylised or realistic
- Shape language: round / angular / mixed; where the big, medium and small shapes are
- Colour palette: 3–5 colours (hex), which one dominates, where the accent is
- Materials / surface: skin, cloth, metal, wood…; roughness; texture or flat colour
- Level of detail: low-poly / mid / high; what detail is modelled vs painted
- Pose / camera: how it is best shown
- What the references do NOT do: (e.g. no realistic pores, no neon colours)`;

// ---------------------------------------------------------------- tool

export type RefMode = "ui" | "image";
export type DesignRefsInput = { topic: string; query?: string; kind?: string; urls?: string[] };
export type DesignRefsResult = { dir: string; kind: RefMode; captured: Captured[]; rejected: Rejected[]; sheet: string | null; text: string };

/** "ui" for web pages/apps, "image" for everything else; guessed from the query when not given. */
export function refMode(input: DesignRefsInput): RefMode {
  if (input.kind === "ui" || input.kind === "image") return input.kind;
  return /\b(website|web ?site|web ?page|landing|page|app|dashboard|ui|ux|interface|form|pricing|portfolio|blog|shop|store|admin|saas|strona|aplikacj|sklep)\b/i.test(`${input.query ?? ""} ${input.topic}`)
    ? "ui"
    : "image";
}

export async function designRefs(input: DesignRefsInput, cwd: string, opts: { offline?: boolean } = {}): Promise<DesignRefsResult> {
  const query = (input.query || input.topic || "").trim();
  const kind = refMode(input);
  const slug = topicSlug(input.topic || query || "ui");
  const dir = join(refsRoot(cwd), slug);
  mkdirSync(dir, { recursive: true });
  const captured: Captured[] = [];
  const rejected: Rejected[] = [];
  let n = readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).length;
  const wantsLogin = /log ?in|sign ?(in|up)|auth|register|logowanie|rejestr/i.test(query);

  if (kind === "image" && !opts.offline && (query || input.urls?.length)) {
    await collectImages(query, input.urls, dir, captured, rejected, () => ++n);
  }

  let urls: { url: string; source: Captured["source"] }[] = [];
  if (kind === "ui" && input.urls?.length) urls = input.urls.slice(0, MAX_ATTEMPTS).map((url) => ({ url, source: "given" }));
  else if (kind === "ui" && !opts.offline && query) {
    const found = await searchPages(query, usedDomains(cwd)).catch((err: unknown) => {
      rejected.push({ url: "(search)", why: err instanceof Error ? err.message : String(err) });
      return [];
    });
    urls = found.map((url) => ({ url, source: "search" }));
  }

  if (kind === "ui" && !opts.offline) {
    // Three pages at a time in the shared browser; stop starting new ones once we have enough.
    const queue = urls.slice(0, MAX_ATTEMPTS);
    let next = 0;
    const worker = async () => {
      while (next < queue.length && captured.length < MAX_REFS) {
        const { url, source } = queue[next++];
        const tmp = join(dir, `.capture-${next}.png`);
        try {
          const why = await withPage({ width: 1280, height: 800 }, (page) => capture(page, url, tmp, wantsLogin));
          if (why) rejected.push({ url, why });
          else if (captured.length >= MAX_REFS) rmSync(tmp, { force: true });
          else {
            const file = join(dir, `${String(++n).padStart(2, "0")}-${topicSlug(host(url) + new URL(url).pathname)}.png`);
            renameSync(tmp, file);
            captured.push({ file, url, source });
          }
        } catch (err) {
          rmSync(tmp, { force: true });
          rejected.push({ url, why: err instanceof Error ? err.message.split("\n")[0] : String(err) });
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  // Local gallery: fills in when the web gave too little, and always offline.
  if (captured.length < 2) {
    for (const g of pickFromGallery(query, MAX_REFS - captured.length)) {
      const file = join(dir, `${String(++n).padStart(2, "0")}-gallery-${topicSlug(basename(g, extname(g)))}${extname(g)}`);
      copyFileSync(g, file);
      captured.push({ file, url: g, source: "gallery" });
    }
  }

  const sourcesFile = join(dir, "sources.json");
  let prev: unknown[] = [];
  try {
    prev = JSON.parse(readFileSync(sourcesFile, "utf8")) as unknown[];
  } catch {
    /* first run */
  }
  writeFileSync(
    sourcesFile,
    `${JSON.stringify([...prev, ...captured.map((c) => ({ file: basename(c.file), url: c.url, source: c.source, query, at: new Date().toISOString() }))], null, 2)}\n`,
  );

  const fresh = captured.map((c) => c.file);
  const sheet = fresh.length ? await contactSheet(fresh, join(dir, ".sheet.jpg")) : null;
  const rel = (p: string) => (p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p);
  const lines = [
    fresh.length
      ? `Inspiration for "${query}" in ${rel(dir)}/ (shown above as one contact sheet):`
      : `No usable references for "${query}". Try a different, more specific query, pass urls, or work from the skill's rules.`,
    ...captured.map((c) => `- ${rel(c.file)}  ← ${c.url}`),
  ];
  if (rejected.length) lines.push("", "Skipped:", ...rejected.map((r) => `- ${r.url}: ${r.why}`));
  if (fresh.length) {
    lines.push(
      "",
      "These are inspiration, not templates. Decide which ones actually look good for THIS task and why " +
        "(look at a single file for detail). Run design_refs again with another query if none fit.",
      kind === "ui"
        ? `Then write ${rel(dir)}/brief.md with this template — traits (mood, density, type, colour budget, shape), never a layout to copy:`
        : `Then write ${rel(dir)}/brief.md with this template — what makes the subject read well, never a copy of one picture:`,
      "",
      (kind === "ui" ? BRIEF_TEMPLATE : IMAGE_BRIEF_TEMPLATE).replace("<topic>", input.topic || query),
    );
  }
  return { dir, kind, captured, rejected, sheet, text: lines.join("\n") };
}

/** Up to 4 references in a 2×2 grid, one image instead of four (cheap for the model's context). */
async function contactSheet(files: string[], out: string): Promise<string> {
  const labels = files.flatMap((f) => ["-label", basename(f)]);
  const args = ["montage", ...files.flatMap((f, i) => [labels[i * 2], labels[i * 2 + 1], `${f}[0]`])];
  await run("magick", [...args, "-tile", "2x", "-geometry", "640x400+6+6", "-background", "#e8e8e8", ...(await fontArgs()), "-pointsize", "13", "-quality", "85", out], { timeout: 60_000 });
  return out;
}
