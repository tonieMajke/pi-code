import { useEffect, useState } from "react";
import { BarChart3, X } from "lucide-react";
import type { RequestRole, StatsRange, StatsSummary } from "../../shared/protocol";
import type { PiRequest } from "../lib/transport";
import { formatDuration, formatTokens } from "../lib/format";
import { locale, plural, t } from "../../shared/i18n";
import { Segmented } from "./settings-ui";

const ROLE_LABEL: Record<RequestRole, string> = {
  main: t("sesje"),
  critic: t("krytyk"),
  reviewer: t("recenzent"),
  handoff: t("handoff"),
  memory: t("nauka pamięci"),
  compact: t("kompaktowanie"),
  commit: t("opis commitu"),
};

const speed = (v: number | null) => (v === null ? "—" : v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(".", locale() === "pl-PL" ? "," : "."));

/** "Statystyki": how each model behaves on this hardware, from the persistent request log. */
export function StatsDialog({ request, onClose }: { request: PiRequest; onClose: () => void }) {
  const [range, setRange] = useState<StatsRange>(7);
  const [data, setData] = useState<StatsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    request<StatsSummary>({ cmd: "stats_query", range }).then(
      (d) => live && setData(d),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [range, request]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const d = data?.range === range ? data : null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="stats-dialog" role="dialog" aria-label={t("Statystyki modeli")}>
        <button className="icon-btn settings-close" onClick={onClose} title={t("Zamknij (Esc)")}>
          <X size={16} />
        </button>
        <h2>
          <BarChart3 size={17} /> {t("Statystyki modeli")}
        </h2>
        <p className="settings-note">
          {t("Każde zapytanie do llama.cpp, ze wszystkich sesji. Modele z API nie podają czasów, więc ich tu nie ma.")}
        </p>
        <div className="stats-bar">
          <Segmented
            value={String(range)}
            options={[
              { value: "7", label: t("7 dni") },
              { value: "30", label: t("30 dni") },
              { value: "all", label: t("wszystko") },
            ]}
            onChange={(v) => setRange(v === "all" ? "all" : (Number(v) as 7 | 30))}
          />
          {d && (
            <span className="stats-total">
              {plural(d.total.requests, ["{n} zapytanie", "{n} zapytania", "{n} zapytań"], ["{n} request", "{n} requests"])}
              {t(" · ↑ {prompt} · ↓ {gen}", { prompt: formatTokens(d.total.promptTokens), gen: formatTokens(d.total.genTokens) })}
            </span>
          )}
        </div>
        {error && <p className="settings-note err">{error}</p>}
        {!d && !error && <p className="settings-note">{t("wczytywanie…")}</p>}
        {d && d.total.requests === 0 && <p className="stats-empty">{t("Brak zapytań w tym okresie.")}</p>}
        {d && d.total.requests > 0 && (
          <>
            <h3>{t("Modele")}</h3>
            <div className="stats-table-wrap">
              <table className="stats-table">
                <thead>
                  <tr>
                    <th>{t("Model")}</th>
                    <th className="num">{t("Zapytania")}</th>
                    <th className="num" title={t("Tokeny przetworzone od nowa (bez cache)")}>↑ prompt</th>
                    <th className="num" title={t("Jaka część promptu przyszła z cache KV")}>cache</th>
                    <th className="num" title={t("Prędkość czytania promptu: mediana / 10. percentyl (zapytania od 512 nowych tokenów)")}>PP t/s</th>
                    <th className="num" title={t("Prędkość generowania: mediana / 10. percentyl (odpowiedzi od 32 tokenów)")}>gen t/s</th>
                    <th className="num" title={t("Czas do pierwszego tokenu (mediana)")}>TTFT</th>
                  </tr>
                </thead>
                <tbody>
                  {d.models.map((m) => (
                    <tr key={m.model}>
                      <td className="model" title={m.model}>{m.model || "?"}</td>
                      <td className="num">{m.requests.toLocaleString(locale())}</td>
                      <td className="num">{formatTokens(m.promptTokens)}</td>
                      <td className="num">{Math.round(m.cacheHitPct)}%</td>
                      <td className="num">
                        {speed(m.ppMedian)} <span className="dim">/ {speed(m.ppP10)}</span>
                      </td>
                      <td className="num">
                        {speed(m.genMedian)} <span className="dim">/ {speed(m.genP10)}</span>
                      </td>
                      <td className="num">{m.ttftMedianMs === null ? "—" : formatDuration(m.ttftMedianMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3>{t("Tokeny dziennie")}</h3>
            <div className="stats-charts">
              <DayBars days={d.days} value={(x) => x.promptTokens} title={t("↑ przetworzony prompt")} />
              <DayBars days={d.days} value={(x) => x.genTokens} title={t("↓ wygenerowane")} />
            </div>

            <div className="stats-cols">
              <div>
                <h3>{t("Projekty")}</h3>
                <ul className="stats-list">
                  {d.projects.slice(0, 8).map((p) => (
                    <li key={p.cwd}>
                      <span className="path" title={p.cwd}>{p.cwd.replace(/^\/home\/[^/]+/, "~") || "?"}</span>
                      <span className="num">{t("{n} zap. · ↑ {prompt}", { n: p.requests, prompt: formatTokens(p.promptTokens) })}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>{t("Narzut pomocników")}</h3>
                {d.overhead.length === 0 ? (
                  <p className="settings-note">{t("Krytyk, recenzent i handoff nic nie kosztowały w tym okresie.")}</p>
                ) : (
                  <ul className="stats-list">
                    {d.overhead.map((o) => (
                      <li key={o.role}>
                        <span>{ROLE_LABEL[o.role]}</span>
                        <span className="num">{t("{n} zap. · ↑ {prompt} · ↓ {gen}", { n: o.requests, prompt: formatTokens(o.promptTokens), gen: formatTokens(o.genTokens) })}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <p className="settings-note stats-file">{d.file.replace(/^\/home\/[^/]+/, "~")}</p>
          </>
        )}
      </div>
    </div>
  );
}

/** One series per chart (prompt and generated tokens differ by ~100×: no shared axis). */
function DayBars({ days, value, title }: { days: StatsSummary["days"]; value: (d: StatsSummary["days"][number]) => number; title: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 320;
  const H = 96;
  const max = Math.max(1, ...days.map(value));
  const n = Math.max(1, days.length);
  const slot = W / n;
  const bar = Math.max(1, Math.min(18, slot - 2)); // 2 px surface gap between bars
  const h = hover !== null ? days[hover] : null;
  return (
    <figure className="stats-chart">
      <figcaption>
        <span>{title}</span>
        <span className="dim">{h ? `${h.day} · ${formatTokens(value(h))}` : t("max {v}", { v: formatTokens(max) })}</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={title} onMouseLeave={() => setHover(null)}>
        <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} className="axis" />
        {days.map((d, i) => {
          const v = value(d);
          const bh = v > 0 ? Math.max(2, (v / max) * (H - 4)) : 0;
          const x = i * slot + (slot - bar) / 2;
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)}>
              {/* hit target: the whole column, bigger than the mark */}
              <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />
              {bh > 0 && <rect x={x} y={H - bh} width={bar} height={bh} rx={Math.min(4, bar / 2)} className={`bar ${hover === i ? "on" : ""}`} />}
            </g>
          );
        })}
      </svg>
      <div className="stats-axis dim">
        <span>{days[0]?.day.slice(5)}</span>
        <span>{days[days.length - 1]?.day.slice(5)}</span>
      </div>
    </figure>
  );
}
