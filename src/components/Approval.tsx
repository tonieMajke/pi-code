import { useEffect, useState } from "react";
import { Hand } from "lucide-react";
import type { ApprovalDecision } from "../../shared/protocol";
import type { Approval } from "../lib/reducer";
import { summarizeArgs, ToolPreview, toolVerb } from "../lib/tool-card";
import { bashPrefixes } from "../../shared/shell";

const ASK_TEXT: Record<string, string> = {
  bash: "uruchomić polecenie",
  edit: "edytować plik",
  write: "zapisać plik",
};

/**
 * Permission prompt for the oldest parked tool call (Claude Code style):
 * Enter = allow, A = always this session, Esc = deny (composer text is sent as the reason).
 */
export function ApprovalCard({
  approval,
  queued,
  cwd,
  onDecide,
  reasonDraft,
}: {
  approval: Approval;
  queued: number;
  cwd: string;
  onDecide: (d: ApprovalDecision, reason?: string) => void;
  reasonDraft: string;
}) {
  const [busy, setBusy] = useState(false);
  const decide = (d: ApprovalDecision) => {
    if (busy) return;
    setBusy(true);
    onDecide(d, d === "deny" && reasonDraft.trim() ? reasonDraft.trim() : undefined);
  };

  useEffect(() => {
    setBusy(false);
  }, [approval.toolCallId]);

  // bash is remembered by prefix ("pnpm test"); inline code (python3 -c …) cannot be remembered at all.
  const prefixes =
    approval.toolName === "bash" ? bashPrefixes(String((approval.args as { command?: unknown } | null)?.command ?? "")) : undefined;
  const canAlways = prefixes !== null;

  useEffect(() => {
    // Capture phase + stopPropagation: these keys must not also reach the composer
    // (Enter would send the draft as a steering message) or the global Esc (abort).
    const onKey = (e: KeyboardEvent) => {
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === "Escape") {
        handled();
        decide("deny");
      } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        handled();
        // With a draft typed, Enter means "no — do this instead".
        decide(reasonDraft.trim() ? "deny" : "allow");
      } else if ((e.key === "a" || e.key === "A") && e.altKey && canAlways) {
        handled();
        decide("always");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const tool = { id: approval.toolCallId, name: approval.toolName, args: approval.args, status: "running" as const, summary: "" };
  const target = summarizeArgs(approval.args, cwd);

  return (
    <div className="approval" role="alertdialog" aria-label="Zgoda na narzędzie">
      <div className="approval-head">
        <Hand size={15} />
        <span>
          pi chce {ASK_TEXT[approval.toolName] ?? `użyć narzędzia ${toolVerb(approval.toolName)}`}
          {approval.toolName !== "bash" && target && <code className="approval-target">{target}</code>}
        </span>
        {queued > 0 && <span className="approval-queue">+{queued} w kolejce</span>}
      </div>
      <div className="approval-body">
        <ToolPreview tool={tool} cwd={cwd} preview />
      </div>
      <div className="approval-actions">
        <button className="btn primary" onClick={() => decide("allow")} disabled={busy}>
          Pozwól <kbd>Enter</kbd>
        </button>
        {canAlways && (
          <button
            className="btn"
            onClick={() => decide("always")}
            disabled={busy}
            title={prefixes ? "Każde polecenie zaczynające się tak samo przejdzie bez pytania do końca tej sesji (ryzykowne dalej pytają)" : undefined}
          >
            {prefixes ? (
              <>
                Zawsze <code className="approval-prefix">{prefixes.join(", ")}</code> w tej sesji
              </>
            ) : (
              "Zawsze w tej sesji"
            )}{" "}
            <kbd>Alt A</kbd>
          </button>
        )}
        <button className="btn danger" onClick={() => decide("deny")} disabled={busy}>
          Odmów <kbd>Esc</kbd>
        </button>
        <span className="approval-hint">
          {reasonDraft.trim()
            ? "Enter: odmów i przekaż modelowi tekst z pola poniżej"
            : "albo wpisz poniżej, co zrobić inaczej"}
        </span>
      </div>
    </div>
  );
}
