import { SquareTerminal } from "lucide-react";
import { t } from "../../shared/i18n";

/**
 * Shown above the composer while the active session lives in a real pi terminal:
 * the composer is blocked and the user can kill the terminal and take the session back.
 */
export function TerminalBar({ onTakeback }: { onTakeback: () => void }) {
  return (
    <div className="terminal-bar">
      <SquareTerminal size={14} />
      <span>{t("Sesja otwarta w terminalu (pi)")}</span>
      <button className="btn" onClick={onTakeback}>
        {t("Przejmij z powrotem")}
      </button>
    </div>
  );
}
