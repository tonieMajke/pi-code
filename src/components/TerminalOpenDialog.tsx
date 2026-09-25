import { useState } from "react";
import { t } from "../../shared/i18n";
import { ConfirmDialog } from "./ConfirmDialog";

/** One-time warning before the session is handed to a real pi terminal; „Nie pokazuj więcej” is persisted by the caller. */
export function TerminalOpenDialog({
  fork,
  onOpen,
  onCancel,
}: {
  fork: boolean;
  onOpen: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}) {
  const [dontAsk, setDontAsk] = useState(false);
  return (
    <ConfirmDialog title={t("Sesja w terminalu")} confirmLabel={t("Otwórz")} onConfirm={() => onOpen(dontAsk)} onCancel={onCancel}>
      <p>{t("W terminalu działa czyste pi — bez konstytucji, podglądu i recenzji z Pi Code.")}</p>
      {fork ? (
        <p>{t("Otworzy się kopia sesji; ta tutaj zostaje w GUI.")}</p>
      ) : (
        <p>{t("Na czas terminala GUI tylko czyta tę sesję.")}</p>
      )}
      <label className="confirm-dontask">
        <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
        {t("Nie pokazuj więcej")}
      </label>
    </ConfirmDialog>
  );
}
