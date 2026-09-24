import { X } from "lucide-react";

export type Toast = { id: number; text: string; level: "info" | "warning" | "error" };

/** Short messages that do not belong in the transcript (extensions, quick confirmations). */
export function Toasts({ toasts, onClose }: { toasts: Toast[]; onClose: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.level}`}>
          <span className="toast-text">{t.text}</span>
          <button className="icon-btn" onClick={() => onClose(t.id)} title="Zamknij">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
