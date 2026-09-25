// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TerminalOpenDialog } from "./TerminalOpenDialog";
import { isTerminalWarnHidden, markTerminalWarnHidden } from "../lib/terminal-warn";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

describe("terminal open warning", () => {
  it("shows once; after „Nie pokazuj więcej” it is hidden permanently", () => {
    expect(isTerminalWarnHidden()).toBe(false); // first open: the dialog is shown
    markTerminalWarnHidden();
    expect(isTerminalWarnHidden()).toBe(true); // and it stays hidden
  });

  it("confirming without the checkbox keeps the warning; with the checkbox it hides it", () => {
    // Mirrors App.tsx: the dialog reports the checkbox; the caller persists it.
    const onOpen = vi.fn((dont: boolean) => {
      if (dont) markTerminalWarnHidden();
    });
    render(<TerminalOpenDialog fork={false} onOpen={onOpen} onCancel={vi.fn()} />);
    expect(screen.getByText(/W terminalu działa czyste pi/)).toBeTruthy();
    expect(screen.queryByText(/Otworzy się kopia sesji/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Otwórz" }));
    expect(onOpen).toHaveBeenCalledWith(false);
    expect(isTerminalWarnHidden()).toBe(false);

    cleanup();
    render(<TerminalOpenDialog fork={true} onOpen={onOpen} onCancel={vi.fn()} />);
    expect(screen.getByText(/Otworzy się kopia sesji/)).toBeTruthy();
    fireEvent.click(screen.getByText("Nie pokazuj więcej"));
    fireEvent.click(screen.getByRole("button", { name: "Otwórz" }));
    expect(onOpen).toHaveBeenLastCalledWith(true);
    expect(isTerminalWarnHidden()).toBe(true);
  });
});
