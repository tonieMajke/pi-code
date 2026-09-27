import { useEffect, useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import type { CleanupScan } from "../../shared/protocol";
import { plural, t } from "../../shared/i18n";
import { CopyButton } from "../lib/code-block";
import { relativeTime } from "../lib/format";
import type { PiRequest } from "../lib/transport";
import { ConfirmDialog } from "./ConfirmDialog";

const tilde = (p: string) => p.replace(/^\/home\/[^/]+/, "~");

/**
 * Settings → Cleanup: sessions that look like test runs (to the system trash, after a
 * confirmation) and sidecars left running by an app or bridge that is gone — shown with a
 * command to copy; Pi Code never kills them itself.
 */
export function CleanupSection({ request, onDeleted }: { request: PiRequest; onDeleted: () => void }) {
  const [scan, setScan] = useState<CleanupScan | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const load = () => {
    setError("");
    request<CleanupScan>({ cmd: "cleanup_scan" }).then(
      (s) => {
        setScan(s);
        setPicked(new Set());
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const sessions = scan?.sessions ?? [];
  const toggle = (path: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  const remove = async () => {
    setConfirm(false);
    setDeleting(true);
    const failed: string[] = [];
    for (const path of picked) await request({ cmd: "session_delete", path }).catch(() => failed.push(path));
    setDeleting(false);
    if (failed.length) setError(t("Nie udało się usunąć: {list}", { list: failed.map(tilde).join(", ") }));
    onDeleted();
    load();
  };

  return (
    <>
      <h2>
        {t("Sprzątanie")}
        <button className="icon-btn cleanup-refresh" onClick={load} title={t("Odśwież")}>
          <RefreshCw size={14} />
        </button>
      </h2>
      {error && <p className="settings-note err">{error}</p>}

      <h3>{t("Sesje testowe")}</h3>
      <p className="settings-note">
        {t("Rozmowy, które wyglądają na testy: z katalogów tymczasowych, z testu e2e, krótkie „powiedz jednym słowem”. Usunięte trafiają do kosza systemowego — da się je przywrócić.")}
      </p>
      {!scan ? (
        <div className="s-empty">{t("Szukam…")}</div>
      ) : sessions.length === 0 ? (
        <div className="s-empty">{t("Nie ma nic do sprzątnięcia.")}</div>
      ) : (
        <>
          <div className="cleanup-bar">
            <button className="btn" onClick={() => setPicked(picked.size === sessions.length ? new Set() : new Set(sessions.map((s) => s.path)))}>
              {picked.size === sessions.length ? t("Odznacz wszystkie") : t("Zaznacz wszystkie")}
            </button>
            <button className="btn danger" disabled={!picked.size || deleting} onClick={() => setConfirm(true)}>
              <Trash2 size={13} /> {t("Do kosza ({n})", { n: picked.size })}
            </button>
          </div>
          <div className="cleanup-list">
            {sessions.map((s) => (
              <label key={s.path} className="cleanup-row" title={s.path}>
                <input type="checkbox" checked={picked.has(s.path)} onChange={() => toggle(s.path)} />
                <span className="cleanup-title">{s.title || t("(bez wiadomości)")}</span>
                <span className="cleanup-meta">
                  {tilde(s.cwd)} · {relativeTime(s.modified)} · <em>{t(s.reason)}</em>
                </span>
              </label>
            ))}
          </div>
        </>
      )}

      <h3>{t("Osierocone procesy sidecara")}</h3>
      <p className="settings-note">
        {t("Sidecary, których aplikacja albo mostek już nie działa (rodzicem jest systemd). Zajmują pamięć, a MCP i rozszerzenia działają w nich dalej. Pi Code ich nie zabija — skopiuj polecenie i uruchom je w terminalu.")}
      </p>
      {scan && scan.orphans.length === 0 && <div className="s-empty">{t("Brak — wszystkie sidecary mają swoją aplikację.")}</div>}
      {scan && scan.orphans.length > 0 && (
        <>
          <div className="cleanup-list">
            {scan.orphans.map((o) => (
              <div key={o.pid} className="cleanup-row" title={o.cmd}>
                <span className="cleanup-title">
                  PID {o.pids.join(", ")}
                </span>
                <span className="cleanup-meta">
                  {t("od {started}", { started: o.started })} · <code>{o.cmd}</code>
                </span>
              </div>
            ))}
          </div>
          <div className="cleanup-cmd">
            <code>{scan.killCommand}</code>
            <CopyButton text={scan.killCommand} />
          </div>
        </>
      )}

      {confirm && (
        <ConfirmDialog
          title={plural(picked.size, ["Przenieść {n} sesję do kosza?", "Przenieść {n} sesje do kosza?", "Przenieść {n} sesji do kosza?"], ["Move {n} chat to the trash?", "Move {n} chats to the trash?"])}
          confirmLabel={t("Do kosza")}
          danger
          onConfirm={() => void remove()}
          onCancel={() => setConfirm(false)}
        >
          {t("Pliki sesji trafią do kosza systemowego; da się je przywrócić z menedżera plików.")}
        </ConfirmDialog>
      )}
    </>
  );
}
