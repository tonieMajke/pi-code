import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { t } from "../../shared/i18n";

/** Ctrl+F over the transcript: Enter / Shift+Enter step through hits, Esc closes. */
export function FindBar({
  query,
  onQuery,
  current,
  total,
  onStep,
  onClose,
  focusKey,
}: {
  query: string;
  onQuery: (q: string) => void;
  /** 0-based index of the current hit. */
  current: number;
  total: number;
  onStep: (dir: 1 | -1) => void;
  onClose: () => void;
  /** Changes on every Ctrl+F — refocuses and selects the field when the bar is already open. */
  focusKey: number;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, [focusKey]);
  return (
    <div className="find-bar" role="search">
      <Search size={14} className="find-icon" />
      <input
        ref={ref}
        value={query}
        placeholder={t("Szukaj w rozmowie")}
        aria-label={t("Szukaj w rozmowie")}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            // preventDefault: the global Esc handler would also stop the model.
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className={`find-count ${query.trim() && !total ? "none" : ""}`}>
        {query.trim() ? (total ? `${current + 1}/${total}` : t("brak")) : ""}
      </span>
      <button className="icon-btn" onClick={() => onStep(-1)} disabled={!total} title={t("Poprzednie (Shift+Enter)")}>
        <ChevronUp size={14} />
      </button>
      <button className="icon-btn" onClick={() => onStep(1)} disabled={!total} title={t("Następne (Enter)")}>
        <ChevronDown size={14} />
      </button>
      <button className="icon-btn" onClick={onClose} title={t("Zamknij (Esc)")}>
        <X size={14} />
      </button>
    </div>
  );
}
