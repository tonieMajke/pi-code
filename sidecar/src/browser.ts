import { existsSync } from "node:fs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

/**
 * One headless Firefox (system install, WebDriver BiDi) shared by look, ui_audit and
 * design_refs. Starting it costs ~1 s, so it stays up between calls and closes
 * itself after a quiet minute. No Chromium download, no user profile touched.
 */
const IDLE_MS = 60_000;
const FIREFOX = process.env.PI_GUI_FIREFOX ?? "/usr/bin/firefox";

let browser: Promise<Browser> | null = null;
let users = 0;
let idle: NodeJS.Timeout | null = null;

function launch(): Promise<Browser> {
  if (!existsSync(FIREFOX)) throw new Error(`no Firefox at ${FIREFOX} (set PI_GUI_FIREFOX)`);
  const b = puppeteer.launch({ browser: "firefox", executablePath: FIREFOX, headless: true, timeout: 30_000 });
  b.then((x) => x.on("disconnected", () => (browser = null))).catch(() => (browser = null));
  return b;
}

export type PageOptions = { width: number; height: number };

/** Run fn on a fresh page; the page is always closed, the browser kept warm. */
export async function withPage<T>(opts: PageOptions, fn: (page: Page) => Promise<T>): Promise<T> {
  if (idle) clearTimeout(idle);
  idle = null;
  users++;
  let page: Page | null = null;
  try {
    browser ??= launch();
    page = await (await browser).newPage();
    await page.setViewport({ width: opts.width, height: opts.height });
    return await fn(page);
  } finally {
    await page?.close().catch(() => undefined);
    users--;
    if (users === 0) {
      idle = setTimeout(() => void closeBrowser(), IDLE_MS);
      idle.unref();
    }
  }
}

export async function closeBrowser(): Promise<void> {
  const b = browser;
  browser = null;
  if (b) await (await b).close().catch(() => undefined);
}

/**
 * Navigate and wait until the page has settled: load event, web fonts, then a short
 * pause for entrance animations (marketing sites fade their content in).
 */
export async function open(page: Page, url: string, settleMs = 600): Promise<void> {
  await page.goto(url, { waitUntil: "load", timeout: 30_000 });
  await page.evaluate(() => document.fonts?.ready.then(() => undefined)).catch(() => undefined);
  await new Promise((r) => setTimeout(r, settleMs));
}
