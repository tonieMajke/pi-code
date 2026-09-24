import { ClipboardList, FilePenLine, ShieldCheck, Zap } from "lucide-react";
import type { PermissionMode } from "../../shared/protocol";

export const MODES: {
  id: PermissionMode;
  label: string;
  desc: string;
  icon: typeof Zap;
}[] = [
  { id: "ask", label: "Pytaj", desc: "Zgoda na każdą edycję i polecenie zmieniające coś", icon: ShieldCheck },
  { id: "acceptEdits", label: "Auto-edycje", desc: "Edycje plików bez pytania, polecenia bash nadal z pytaniem", icon: FilePenLine },
  { id: "plan", label: "Plan", desc: "Tylko odczyt i analiza — model przygotowuje plan, nic nie zmienia", icon: ClipboardList },
  { id: "yolo", label: "YOLO", desc: "Wszystko bez pytania. Model ma wolną rękę", icon: Zap },
];

export function modeInfo(mode: PermissionMode) {
  return MODES.find((m) => m.id === mode) ?? MODES[0];
}

/** Shift+Tab order, like Claude Code (YOLO last so it's never one press away from default). */
export function nextMode(mode: PermissionMode): PermissionMode {
  const i = MODES.findIndex((m) => m.id === mode);
  return MODES[(i + 1) % MODES.length].id;
}
