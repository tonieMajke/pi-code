import { useEffect, useRef, useState } from "react";
import { Puzzle } from "lucide-react";
import type { UiAnswer, UiRequest } from "../../shared/protocol";
import { t } from "../../shared/i18n";

/**
 * A question from a pi extension (ctx.ui.select / confirm / input / editor),
 * shown above the composer like an approval card. Esc cancels.
 */
export function ExtensionDialog({
  request,
  queued,
  onAnswer,
}: {
  request: UiRequest;
  queued: number;
  onAnswer: (answer: UiAnswer) => void;
}) {
  const [text, setText] = useState(request.method === "editor" ? (request.prefill ?? "") : "");
  const [sel, setSel] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const cancel = () => onAnswer({ cancelled: true });

  useEffect(() => {
    // Focus the dialog, not the composer: keys belong to the question now.
    (fieldRef.current ?? boxRef.current)?.focus();
  }, [request.id]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
      return;
    }
    if (request.method === "select") {
      const n = request.options.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => (s + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
      } else if (e.key === "Enter" && n > 0) {
        e.preventDefault();
        onAnswer({ value: request.options[sel] });
      }
    } else if (request.method === "confirm") {
      if (e.key === "Enter" || e.key.toLowerCase() === "t" || e.key.toLowerCase() === "y") {
        e.preventDefault();
        onAnswer({ value: true });
      } else if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        onAnswer({ value: false });
      }
    } else if (e.key === "Enter" && (request.method === "input" || e.ctrlKey)) {
      e.preventDefault();
      onAnswer({ value: text });
    }
  };

  return (
    <div className="ext-dialog" ref={boxRef} tabIndex={-1} onKeyDown={onKey}>
      <div className="ext-head">
        <Puzzle size={14} />
        <span className="ext-title">{request.title}</span>
        {queued > 0 && <span className="ext-queued">+{queued} w kolejce</span>}
      </div>
      {request.method === "confirm" && <div className="ext-message">{request.message}</div>}
      {request.method === "select" && (
        <div className="ext-options">
          {request.options.map((o, i) => (
            <button
              key={`${i}-${o}`}
              className={`ext-option ${i === sel ? "sel" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => onAnswer({ value: o })}
            >
              {o}
            </button>
          ))}
        </div>
      )}
      {request.method === "input" && (
        <input
          ref={fieldRef}
          className="ext-input"
          value={text}
          placeholder={request.placeholder}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      {request.method === "editor" && (
        <textarea ref={fieldRef} className="ext-input ext-editor" value={text} onChange={(e) => setText(e.target.value)} rows={8} />
      )}
      <div className="ext-actions">
        {request.method === "confirm" ? (
          <>
            <button className="btn primary" onClick={() => onAnswer({ value: true })}>
              {t("Tak")}
            </button>
            <button className="btn" onClick={() => onAnswer({ value: false })}>
              {t("Nie")}
            </button>
          </>
        ) : request.method === "select" ? null : (
          <button className="btn primary" onClick={() => onAnswer({ value: text })}>
            OK {request.method === "editor" && <kbd>Ctrl Enter</kbd>}
          </button>
        )}
        <button className="btn" onClick={cancel}>
          {t("Anuluj")} <kbd>Esc</kbd>
        </button>
      </div>
    </div>
  );
}
