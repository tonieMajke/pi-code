// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AddonsMenu } from "./AddonsMenu";
import type { GuiConfig } from "../../shared/protocol";
import { DEFAULT_CONFIG } from "../../sidecar/src/config";

afterEach(cleanup);

function gui(patch: Partial<GuiConfig> = {}): GuiConfig {
  return { ...DEFAULT_CONFIG, ...patch };
}

function open(g: GuiConfig, extensions: string[] = [], onPatch = vi.fn(), onSettings = vi.fn()) {
  render(<AddonsMenu gui={g} extensions={extensions} onPatch={onPatch} onSettings={onSettings} />);
  fireEvent.click(screen.getByText(/^Dodatki/));
  return { onPatch, onSettings };
}

const switchOf = (label: string) => screen.getByText(label, { selector: ".addons-label" }).closest(".addons-row")!.querySelector("button[role=switch]") as HTMLButtonElement;

describe("AddonsMenu", () => {
  it("counts the top-level additions in the chip", () => {
    render(<AddonsMenu gui={gui({ review: { ...DEFAULT_CONFIG.review, enabled: false } })} extensions={[]} onPatch={vi.fn()} onSettings={vi.fn()} />);
    expect(screen.getByText("Dodatki 4/5")).toBeTruthy();
  });

  it("patches the section a switch belongs to", () => {
    const { onPatch } = open(gui());
    fireEvent.click(switchOf("Strażnicy"));
    expect(onPatch).toHaveBeenCalledWith({ constitution: { hard: false } });
    fireEvent.click(switchOf("Recenzja"));
    expect(onPatch).toHaveBeenCalledWith({ review: { enabled: false } });
    fireEvent.click(switchOf("Pamięć"));
    expect(onPatch).toHaveBeenCalledWith({ memory: { enabled: false } });
  });

  it("offers extension switches only for installed extensions", () => {
    open(gui(), ["pi-mcp-adapter"]);
    expect(screen.queryByText("pi-lens", { selector: ".addons-label" })).toBeNull();
    cleanup();
    const { onPatch } = open(gui({ extensions: { disabled: ["guardian"] } }), ["pi-lens", "guardian"]);
    expect(switchOf("pi-lens").getAttribute("aria-checked")).toBe("true");
    expect(switchOf("Strażnik pi").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(switchOf("pi-lens"));
    expect(onPatch).toHaveBeenCalledWith({ extension: { name: "pi-lens", enabled: false } });
  });

  it("greys out a sub-switch under a disabled parent", () => {
    open(gui({ taste: { ...DEFAULT_CONFIG.taste, enabled: false } }));
    const critic = switchOf("Krytyk");
    expect(critic.disabled).toBe(true);
    expect(critic.getAttribute("aria-checked")).toBe("false");
  });

  it("turns everything off in one click and back on", () => {
    const { onPatch } = open(gui(), ["pi-lens"]);
    fireEvent.click(screen.getByText("Wyłącz wszystkie"));
    expect(onPatch).toHaveBeenCalledTimes(8);
    cleanup();
    const off = gui({
      constitution: { ...DEFAULT_CONFIG.constitution, enabled: false, hard: false },
      review: { ...DEFAULT_CONFIG.review, enabled: false },
      taste: { ...DEFAULT_CONFIG.taste, enabled: false, critic: false },
      turnLimit: { ...DEFAULT_CONFIG.turnLimit, enabled: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false },
      extensions: { disabled: ["pi-lens"] },
    });
    const again = open(off, ["pi-lens"]);
    expect(screen.getByText("Dodatki: wył.")).toBeTruthy();
    fireEvent.click(screen.getByText("Włącz wszystkie"));
    expect(again.onPatch).toHaveBeenCalledTimes(8);
  });
});
