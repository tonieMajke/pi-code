import { Paperclip, Plus } from "lucide-react";
import type { GuiConfig, SettingsPatch } from "../../shared/protocol";
import { Menu } from "./Menu";
import { Toggle } from "./settings-ui";
import { t } from "../../shared/i18n";

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

/**
 * Pi Code's own additions to plain pi — the ones worth switching off mid-task. A function, not a
 * const: the names and notes are UI copy and the language can change while the app runs.
 */
const addonCatalog = (): Addon[] => [
  {
    key: "constitution",
    label: t("Konstytucja"),
    desc: t("zasady pracy w prompcie systemowym; zmiana przelicza kontekst przy następnej wiadomości"),
    on: (g) => g.constitution.enabled,
    patch: (v) => ({ constitution: { enabled: v } }),
  },
  {
    key: "guards",
    label: t("Strażnicy"),
    desc: t("czytaj przed edycją, pętle bez postępu, przypomnienia o weryfikacji"),
    on: (g) => g.constitution.hard,
    patch: (v) => ({ constitution: { hard: v } }),
    parent: "constitution",
  },
  {
    key: "review",
    label: t("Recenzja"),
    desc: t("drugi przegląd zmian w kodzie po skończonej pracy"),
    on: (g) => g.review.enabled,
    patch: (v) => ({ review: { enabled: v } }),
  },
  {
    key: "taste",
    label: t("Gust"),
    desc: t("samokorekta wyglądu: zrzuty i audyt przy pracy wizualnej"),
    on: (g) => g.taste.enabled,
    patch: (v) => ({ taste: { enabled: v } }),
  },
  {
    key: "critic",
    label: t("Krytyk"),
    desc: t("osobne spojrzenie na zrzut przed oddaniem"),
    on: (g) => g.taste.critic,
    patch: (v) => ({ taste: { critic: v } }),
    parent: "taste",
  },
  {
    key: "turnLimit",
    label: t("Limit tury"),
    desc: t("status po kilku krokach albo minutach bez tekstu"),
    on: (g) => g.turnLimit.enabled,
    patch: (v) => ({ turnLimit: { enabled: v } }),
  },
  {
    key: "memory",
    label: t("Pamięć"),
    desc: t("zapamiętane fakty w prompcie i nauka po sesji; zmiana przelicza kontekst"),
    on: (g) => g.memory.enabled,
    patch: (v) => ({ memory: { enabled: v } }),
  },
  extensionAddon("pi-lens", "pi-lens", t("diagnostyka LSP i lint po każdej edycji; przeładowanie po skończonej turze")),
  extensionAddon("guardian", t("Strażnik pi"), t("limit czytań z ~/.pi/agent/extensions; przeładowanie po skończonej turze")),
];

/** Effective state: a sub-switch under a disabled parent does nothing. */
function effective(g: GuiConfig, a: Addon, all: Addon[]): boolean {
  const parent = a.parent ? all.find((p) => p.key === a.parent) : undefined;
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
  const shown = addonCatalog().filter((a) => !a.extension || extensions.includes(a.extension));
  const top = shown.filter((a) => !a.parent);
  const on = top.filter((a) => a.on(gui)).length;
  const label = on === 0 ? t("Dodatki: wył.") : on === top.length ? t("Dodatki") : t("Dodatki {on}/{all}", { on, all: top.length });
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
        <span className="icon-btn addons-plus" title={t("Dołącz obraz · {label}", { label })}>
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
            <span className="menu-label">{t("Dołącz obraz")}</span>
            <span className="menu-hint">{t("albo wklej / upuść")}</span>
          </button>
          <div className="addons-head">{t("Dodatki Pi Code")}</div>
          {shown.map((a) => {
            const parentOff = a.parent ? !shown.find((p) => p.key === a.parent)!.on(gui) : false;
            return (
              <div key={a.key} className={`addons-row ${a.parent ? "sub" : ""} ${parentOff ? "dim" : ""}`}>
                <div className="addons-text">
                  <div className="addons-label">{a.label}</div>
                  <div className="addons-desc">{a.desc}</div>
                </div>
                <Toggle value={effective(gui, a, shown)} disabled={parentOff} onChange={(v) => onPatch(a.patch(v))} />
              </div>
            );
          })}
          <div className="addons-note">{t("Dotyczy wszystkich sesji, działa od następnego kroku modelu.")}</div>
          <div className="ctx-actions">
            <button className="btn" onClick={() => setAll(on === 0)}>
              {on === 0 ? t("Włącz wszystkie") : t("Wyłącz wszystkie")}
            </button>
            <button
              className="btn"
              onClick={() => {
                close();
                onSettings();
              }}
            >
              {t("Ustawienia…")}
            </button>
          </div>
        </div>
      )}
    />
  );
}
