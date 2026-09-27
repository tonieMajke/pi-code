import { X } from "lucide-react";
import { t } from "../../shared/i18n";

export type Toast = { id: number; text: string; level: "info" | "warning" | "error" };

/** Short messages that do not belong in the transcript (extensions, quick confirmations). */
export function Toasts({ toasts, onClose }: { toasts: Toast[]; onClose: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.level}`}>
          <span className="toast-text">{toast.text}</span>
          <button className="icon-btn" onClick={() => onClose(toast.id)} title={t("Zamknij")}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
