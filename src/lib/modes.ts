import { ClipboardList, FilePenLine, ShieldCheck, Zap } from "lucide-react";
import type { PermissionMode } from "../../shared/protocol";
import { t } from "../../shared/i18n";

/** The permission modes, worded in the language the interface has right now. */
export const modes = (): {
  id: PermissionMode;
  label: string;
  desc: string;
  icon: typeof Zap;
}[] => [
  { id: "ask", label: t("Pytaj"), desc: t("Zgoda na każdą edycję i polecenie zmieniające coś"), icon: ShieldCheck },
  { id: "acceptEdits", label: t("Auto-edycje"), desc: t("Edycje plików bez pytania, polecenia bash nadal z pytaniem"), icon: FilePenLine },
  { id: "plan", label: t("Plan"), desc: t("Tylko odczyt i analiza — model przygotowuje plan, nic nie zmienia"), icon: ClipboardList },
  { id: "yolo", label: "YOLO", desc: t("Wszystko bez pytania. Model ma wolną rękę"), icon: Zap },
];

export function modeInfo(mode: PermissionMode) {
  const all = modes();
  return all.find((m) => m.id === mode) ?? all[0];
}

/** Shift+Tab order, like Claude Code (YOLO last so it's never one press away from default). */
export function nextMode(mode: PermissionMode): PermissionMode {
  const all = modes();
  const i = all.findIndex((m) => m.id === mode);
  return all[(i + 1) % all.length].id;
}
