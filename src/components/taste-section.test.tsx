// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TasteSection } from "./Settings";
import type { ModelSummary, PiSettings, TasteConfig } from "../../shared/protocol";

afterEach(cleanup);

const TASTE: TasteConfig = { enabled: true, research: "auto", critic: true, criticModel: "", maxRounds: 3, requireAudit: true, criticSlot: null };
const MODELS: ModelSummary[] = [
  { provider: "llama-server", id: "vision-27b", name: "vision-27b", contextWindow: 1, vision: true },
  { provider: "llama-server", id: "text-only", name: "text-only", contextWindow: 1, vision: false },
];

function settings(taste: TasteConfig | undefined, modelVision = true): PiSettings {
  return { gui: { taste }, modelVision } as unknown as PiSettings;
}

describe("TasteSection", () => {
  it("shows the loop's switches and patches research mode and rounds", () => {
    const onPatch = vi.fn();
    render(<TasteSection s={settings(TASTE)} models={MODELS} onPatch={onPatch} />);
    expect(screen.getByText("Szukanie wzorców")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "pytaj" }));
    expect(onPatch).toHaveBeenCalledWith({ taste: { research: "ask" } });
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    expect(onPatch).toHaveBeenCalledWith({ taste: { maxRounds: 5 } });
    expect(screen.getByText(/Widzi obrazy/)).toBeTruthy();
  });

  it("warns when the critic's model can't see images", () => {
    render(<TasteSection s={settings({ ...TASTE, criticModel: "llama-server/text-only" })} models={MODELS} onPatch={vi.fn()} />);
    expect(screen.getByText(/nie widzi obrazów/)).toBeTruthy();
  });

  it("hides the details when the loop is off, and survives an old sidecar", () => {
    render(<TasteSection s={settings({ ...TASTE, enabled: false })} models={MODELS} onPatch={vi.fn()} />);
    expect(screen.queryByText("Szukanie wzorców")).toBeNull();
    cleanup();
    render(<TasteSection s={settings(undefined)} models={MODELS} onPatch={vi.fn()} />);
    expect(screen.getByText(/Uruchom ponownie sidecar/)).toBeTruthy();
  });
});
