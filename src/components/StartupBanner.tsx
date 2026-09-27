import { TriangleAlert, X } from "lucide-react";
import { t } from "../../shared/i18n";
import { startupProblemText, type StartupProblem } from "../lib/tauri";

/**
 * The sidecar never started (no node, node too old, spawn failed): the window is up but nothing
 * will answer, so this stays above the chat until dismissed — a toast would be gone in seconds.
 */
export function StartupBanner({ problem, onDismiss }: { problem: StartupProblem; onDismiss: () => void }) {
  return (
    <div className="startup-bar" role="alert">
      <TriangleAlert size={15} />
      <span>{startupProblemText(problem)}</span>
      <button className="icon-btn" onClick={onDismiss} title={t("Zamknij")}>
        <X size={14} />
      </button>
    </div>
  );
}
