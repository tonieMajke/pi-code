import type { SessionSummary } from "../../shared/protocol";
import { lang, locale, t } from "../../shared/i18n";

/** Decimal comma in Polish, point in English. */
const dec = (s: string) => (lang() === "pl" ? s.replace(".", ",") : s);

/** 850 ms → "0,9 s", 72 s → "1 min 12 s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = ms / 1000;
  if (s < 10) return `${dec(s.toFixed(1))} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

/** 12345 → "12,3 tys." ; 262144 → "262 tys." */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  const n2 = dec(k < 100 ? k.toFixed(1) : Math.round(k).toString());
  return lang() === "pl" ? `${n2} tys.` : `${n2}k`;
}

export function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const min = Math.floor(diff / 60000);
  if (min < 1) return t("teraz");
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return lang() === "pl" ? `${h} godz.` : `${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} d`;
  return new Date(iso).toLocaleDateString(locale(), { day: "numeric", month: "short" });
}

export type SessionGroup = { label: string; items: SessionSummary[] };

/** Bucket sessions like Claude desktop: Dziś / Wczoraj / 7 dni / 30 dni / Starsze. */
export function groupSessions(sessions: SessionSummary[], now = new Date()): SessionGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  const buckets: [string, number][] = [
    [t("Dziś"), startOfToday],
    [t("Wczoraj"), startOfToday - day],
    [t("Ostatnie 7 dni"), startOfToday - 7 * day],
    [t("Ostatnie 30 dni"), startOfToday - 30 * day],
    [t("Starsze"), -Infinity],
  ];
  const groups = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const t = new Date(s.modified).getTime();
    const label = buckets.find(([, from]) => t >= from)![0];
    groups.set(label, [...(groups.get(label) ?? []), s]);
  }
  return buckets.filter(([l]) => groups.has(l)).map(([label]) => ({ label, items: groups.get(label)! }));
}

export function sessionTitle(s: Pick<SessionSummary, "name" | "firstMessage" | "id">): string {
  const raw = s.name || s.firstMessage || s.id.slice(0, 8);
  return raw.replace(/\s+/g, " ").trim();
}
