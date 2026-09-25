import { Paperclip, Plus } from "lucide-react";
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
  /** A pi extension: the row shows only when it is installed. */
  extension?: string;
};

/** A pi extension Pi Code can leave out of its sessions. */
function extensionAddon(name: string, label: string, desc: string): Addon {
  return {
    key: `ext:${name}`,
    label,
    desc,
    on: (g) => !g.extensions.disabled.includes(name),
    patch: (v) => ({ extension: { name, enabled: v } }),
    extension: name,
  };
}

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
  {
    key: "memory",
    label: "Pamięć",
    desc: "zapamiętane fakty w prompcie i nauka po sesji; zmiana przelicza kontekst",
    on: (g) => g.memory.enabled,
    patch: (v) => ({ memory: { enabled: v } }),
  },
  extensionAddon("pi-lens", "pi-lens", "diagnostyka LSP i lint po każdej edycji; przeładowanie po skończonej turze"),
  extensionAddon("guardian", "Strażnik pi", "limit czytań z ~/.pi/agent/extensions; przeładowanie po skończonej turze"),
];

/** Effective state: a sub-switch under a disabled parent does nothing. */
function effective(g: GuiConfig, a: Addon): boolean {
  const parent = a.parent ? ADDONS.find((p) => p.key === a.parent) : undefined;
  return a.on(g) && (!parent || parent.on(g));
}

/** The composer's "+" button: attach an image, plus on/off switches for Pi Code's additions (global, pi-gui.json). */
export function AddonsMenu({
  gui,
  onPatch,
  onSettings,
  onAttach,
  extensions,
}: {
  gui: GuiConfig;
  onAttach: () => void;
  /** Names of installed pi extensions (loaded or switched off). */
  extensions: string[];
  onPatch: (patch: SettingsPatch) => void;
  onSettings: () => void;
}) {
  const shown = ADDONS.filter((a) => !a.extension || extensions.includes(a.extension));
  const top = shown.filter((a) => !a.parent);
  const on = top.filter((a) => a.on(gui)).length;
  const label = on === 0 ? "Dodatki: wył." : on === top.length ? "Dodatki" : `Dodatki ${on}/${top.length}`;
  /** The dot says "not everything is on"; the count lives in the tooltip. */
  const partial = on < top.length;
  const setAll = (v: boolean) => {
    for (const a of shown) if (a.on(gui) !== v) onPatch(a.patch(v));
  };
  return (
    <Menu
      className="chip-menu addons-menu"
      items={[]}
      trigger={
        <span className="icon-btn addons-plus" title={`Dołącz obraz · ${label}`}>
          <Plus size={16} />
          {partial && <span className={`addons-dot ${on === 0 ? "off" : ""}`} />}
        </span>
      }
      footer={(close) => (
        <div className="addons-pop">
          <button
            type="button"
            className="menu-item addons-attach"
            onClick={() => {
              close();
              onAttach();
            }}
          >
            <Paperclip size={14} />
            <span className="menu-label">Dołącz obraz</span>
            <span className="menu-hint">albo wklej / upuść</span>
          </button>
          <div className="addons-head">Dodatki Pi Code</div>
          {shown.map((a) => {
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
