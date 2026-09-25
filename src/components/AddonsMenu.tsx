import { ChevronDown, ShieldCheck } from "lucide-react";
import type { GuiConfig, SettingsPatch } from "../../shared/protocol";
import { Menu } from "./Menu";
import { Toggle } from "./settings-ui";

type Addon = {
  key: string;
  label: string;
  desc: string;
  on: (g: GuiConfig) => boolean;
  patch: (v: boolean) => SettingsPatch;
  /** Sub-switch: only matters while the parent is on. */
  parent?: string;
};

/** Pi Code's own additions to plain pi — the ones worth switching off mid-task. */
export const ADDONS: Addon[] = [
  {
    key: "constitution",
    label: "Konstytucja",
    desc: "zasady pracy w prompcie systemowym; zmiana przelicza kontekst przy następnej wiadomości",
    on: (g) => g.constitution.enabled,
    patch: (v) => ({ constitution: { enabled: v } }),
  },
  {
    key: "guards",
    label: "Strażnicy",
    desc: "czytaj przed edycją, pętle bez postępu, przypomnienia o weryfikacji",
    on: (g) => g.constitution.hard,
    patch: (v) => ({ constitution: { hard: v } }),
    parent: "constitution",
  },
  {
    key: "review",
    label: "Recenzja",
    desc: "drugi przegląd zmian w kodzie po skończonej pracy",
    on: (g) => g.review.enabled,
    patch: (v) => ({ review: { enabled: v } }),
  },
  {
    key: "taste",
    label: "Gust",
    desc: "samokorekta wyglądu: zrzuty i audyt przy pracy wizualnej",
    on: (g) => g.taste.enabled,
    patch: (v) => ({ taste: { enabled: v } }),
  },
  {
    key: "critic",
    label: "Krytyk",
    desc: "osobne spojrzenie na zrzut przed oddaniem",
    on: (g) => g.taste.critic,
    patch: (v) => ({ taste: { critic: v } }),
    parent: "taste",
  },
  {
    key: "turnLimit",
    label: "Limit tury",
    desc: "status po kilku krokach albo minutach bez tekstu",
    on: (g) => g.turnLimit.enabled,
    patch: (v) => ({ turnLimit: { enabled: v } }),
  },
];

/** Effective state: a sub-switch under a disabled parent does nothing. */
function effective(g: GuiConfig, a: Addon): boolean {
  const parent = a.parent ? ADDONS.find((p) => p.key === a.parent) : undefined;
  return a.on(g) && (!parent || parent.on(g));
}

/** Composer chip with a pop-up of on/off switches for Pi Code's additions (global, pi-gui.json). */
export function AddonsMenu({
  gui,
  onPatch,
  onSettings,
}: {
  gui: GuiConfig;
  onPatch: (patch: SettingsPatch) => void;
  onSettings: () => void;
}) {
  const top = ADDONS.filter((a) => !a.parent);
  const on = top.filter((a) => a.on(gui)).length;
  const label = on === 0 ? "Dodatki: wył." : on === top.length ? "Dodatki" : `Dodatki ${on}/${top.length}`;
  const setAll = (v: boolean) => {
    for (const a of ADDONS) if (a.on(gui) !== v) onPatch(a.patch(v));
  };
  return (
    <Menu
      className="chip-menu addons-menu"
      items={[]}
      trigger={
        <span className={`chip addons-chip ${on === 0 ? "off" : ""}`} title="Dodatki Pi Code — szybkie włączanie i wyłączanie">
          <ShieldCheck size={13} />
          <span>{label}</span>
          <ChevronDown size={12} className="chev" />
        </span>
      }
      footer={(close) => (
        <div className="addons-pop">
          <div className="addons-head">Dodatki Pi Code</div>
          {ADDONS.map((a) => {
            const parentOff = a.parent ? !ADDONS.find((p) => p.key === a.parent)!.on(gui) : false;
            return (
              <div key={a.key} className={`addons-row ${a.parent ? "sub" : ""} ${parentOff ? "dim" : ""}`}>
                <div className="addons-text">
                  <div className="addons-label">{a.label}</div>
                  <div className="addons-desc">{a.desc}</div>
                </div>
                <Toggle value={effective(gui, a)} disabled={parentOff} onChange={(v) => onPatch(a.patch(v))} />
              </div>
            );
          })}
          <div className="addons-note">Dotyczy wszystkich sesji, działa od następnego kroku modelu.</div>
          <div className="ctx-actions">
            <button className="btn" onClick={() => setAll(on === 0)}>
              {on === 0 ? "Włącz wszystkie" : "Wyłącz wszystkie"}
            </button>
            <button
              className="btn"
              onClick={() => {
                close();
                onSettings();
              }}
            >
              Ustawienia…
            </button>
          </div>
        </div>
      )}
    />
  );
}
