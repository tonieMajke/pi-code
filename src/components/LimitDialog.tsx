import { useEffect } from "react";
import { Square } from "lucide-react";
import type { BackgroundBlock } from "../../shared/protocol";
import { plural, t } from "../../shared/i18n";

/**
 * Leaving a working session would exceed the limit of local-model sessions in the
 * background: the user picks which run to stop (or stays).
 */
export function LimitDialog({ block, onStop, onCancel }: { block: BackgroundBlock; onStop: (session: string) => void; onCancel: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="confirm limit-dialog" role="alertdialog" aria-label={t("Którą sesję zatrzymać?")}>
        <h3>{t("Którą sesję zatrzymać?")}</h3>
        <div className="confirm-body">
          {plural(
            block.limit,
            [
              "Na modelach lokalnych w tle może pracować {n} sesja, a ta, którą zostawiasz, też jeszcze pracuje.",
              "Na modelach lokalnych w tle mogą pracować {n} sesje, a ta, którą zostawiasz, też jeszcze pracuje.",
              "Na modelach lokalnych w tle może pracować {n} sesji, a ta, którą zostawiasz, też jeszcze pracuje.",
            ],
            [
              "Only {n} session may work in the background on local models, and the one you are leaving is still working.",
              "Only {n} sessions may work in the background on local models, and the one you are leaving is still working.",
            ],
          )}{" "}
          {t("Limit zmienisz w Ustawieniach → Zachowanie.")}
        </div>
        <div className="limit-list">
          {block.running.map((r) => (
            <button key={r.session} className="btn limit-item" onClick={() => onStop(r.session)}>
              <Square size={11} />
              <span className="limit-title">{r.title}</span>
              {r.active && <span className="limit-tag">{t("ta, którą zostawiasz")}</span>}
            </button>
          ))}
        </div>
        <div className="confirm-actions">
          <button className="btn" onClick={onCancel}>
            {t("Zostań w tej sesji")}
          </button>
        </div>
      </div>
    </div>
  );
}
