// @vitest-environment jsdom
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Composer } from "./Composer";
import { ExtensionDialog } from "./ExtensionDialog";
import { allCommands, type PickItem, type SlashPick } from "../lib/slash";

afterEach(cleanup);

const commands = allCommands([{ name: "memory", description: "Show persistent user memory", source: "extension" }]);
const MODELS: PickItem[] = [
  { key: "llama/Swift", label: "Swift", active: true },
  { key: "llama/Tiel", label: "Tiel" },
];

function Harness({ onCommand, onNeedPick }: { onCommand: (n: string, a: string) => void; onNeedPick: (p: SlashPick) => void }) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <Composer
      value={value}
      onChange={setValue}
      onSend={vi.fn()}
      onStop={vi.fn()}
      busy={false}
      connected
      pending={[]}
      model="Swift"
      provider="llama"
      models={[]}
      onModel={vi.fn()}
      cwd="/tmp/p"
      branch=""
      sessions={[]}
      onProject={vi.fn()}
      usage={null}
      inputRef={ref}
      hero={false}
      mode="ask"
      onMode={vi.fn()}
      attachments={[]}
      onAddFiles={vi.fn()}
      onRemoveAttachment={vi.fn()}
      blocked={false}
      files={null}
      onNeedFiles={vi.fn()}
      commands={commands}
      pickItems={(p) => (p === "model" ? MODELS : null)}
      onNeedPick={onNeedPick}
      onCommand={onCommand}
    />
  );
}

function setup() {
  const onCommand = vi.fn();
  const onNeedPick = vi.fn();
  render(<Harness onCommand={onCommand} onNeedPick={onNeedPick} />);
  const box = screen.getByRole("textbox") as HTMLTextAreaElement;
  const type = (value: string) => fireEvent.change(box, { target: { value } });
  const key = (k: string) => fireEvent.keyDown(box, { key: k });
  return { box, type, key, onCommand, onNeedPick };
}

describe("Composer: slash commands", () => {
  it("lists commands after '/', filters while typing and runs the chosen one with Enter", () => {
    const { type, key, onCommand } = setup();
    type("/");
    expect(screen.getByText("/compact")).toBeTruthy();
    expect(screen.getByText("/memory")).toBeTruthy();
    expect(screen.getByText("rozszerzenie")).toBeTruthy();
    type("/mem");
    expect(screen.queryByText("/compact")).toBeNull();
    key("Enter");
    expect(onCommand).toHaveBeenCalledWith("memory", "");
  });

  it("a picker command opens its list; arrows + Enter pick the item", () => {
    const { box, type, key, onCommand, onNeedPick } = setup();
    type("/mod");
    key("Enter"); // "/model" is first: completes instead of running
    expect(box.value).toBe("/model ");
    type("/model ");
    expect(onNeedPick).toHaveBeenCalledWith("model");
    expect(screen.getByText("Model tej sesji")).toBeTruthy();
    key("ArrowDown");
    key("Enter");
    expect(onCommand).toHaveBeenCalledWith("model", "llama/Tiel");
  });

  it("filters picker items by what follows the name", () => {
    const { type } = setup();
    type("/model ti");
    const pop = within(document.querySelector<HTMLElement>(".slash-pop")!);
    expect(pop.getByText("Tiel")).toBeTruthy();
    expect(pop.queryByText("Swift")).toBeNull();
  });

  it("a command with a required argument completes instead of running; Esc closes the list", () => {
    const { box, type, key, onCommand } = setup();
    type("/nam");
    key("Enter");
    expect(box.value).toBe("/name ");
    expect(onCommand).not.toHaveBeenCalled();
    type("/");
    key("Escape");
    expect(screen.queryByText("/compact")).toBeNull();
  });

  it("paths are not commands", () => {
    const { type } = setup();
    type("/home/majke/x");
    expect(screen.queryByText("brak takiej komendy")).toBeNull();
    expect(screen.queryByText("/compact")).toBeNull();
  });
});

describe("ExtensionDialog", () => {
  it("select: arrows and Enter answer with the option", () => {
    const onAnswer = vi.fn();
    render(<ExtensionDialog request={{ id: "1", method: "select", title: "Serwer", options: ["a", "b"] }} queued={0} onAnswer={onAnswer} />);
    const box = screen.getByText("Serwer").closest(".ext-dialog")!;
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onAnswer).toHaveBeenCalledWith({ value: "b" });
  });

  it("confirm: Tak / Nie / Esc", () => {
    const onAnswer = vi.fn();
    render(<ExtensionDialog request={{ id: "1", method: "confirm", title: "Usunąć?", message: "plik x" }} queued={2} onAnswer={onAnswer} />);
    expect(screen.getByText("+2 w kolejce")).toBeTruthy();
    fireEvent.click(screen.getByText("Nie"));
    expect(onAnswer).toHaveBeenLastCalledWith({ value: false });
    fireEvent.keyDown(screen.getByText("Usunąć?").closest(".ext-dialog")!, { key: "Escape" });
    expect(onAnswer).toHaveBeenLastCalledWith({ cancelled: true });
  });

  it("input: typed text goes back on Enter", () => {
    const onAnswer = vi.fn();
    render(<ExtensionDialog request={{ id: "1", method: "input", title: "Token", placeholder: "wklej" }} queued={0} onAnswer={onAnswer} />);
    const field = screen.getByPlaceholderText("wklej");
    fireEvent.change(field, { target: { value: "abc" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onAnswer).toHaveBeenCalledWith({ value: "abc" });
  });
});
