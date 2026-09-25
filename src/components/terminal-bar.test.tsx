// @vitest-environment jsdom
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "./Composer";
import { TerminalBar } from "./TerminalBar";
import { allCommands, type SlashPick } from "../lib/slash";
import { initialState, reducer } from "../lib/reducer";

afterEach(cleanup);

const ev = (open: boolean) =>
  reducer(initialState, { type: "event", event: { kind: "terminal_state", open }, at: Date.now() });

/** Mirrors App: the composer is blocked exactly while the session lives in a terminal. */
function Harness({ blocked, onSend, onTakeback }: { blocked: boolean; onSend: () => void; onTakeback: () => void }) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      {blocked && <TerminalBar onTakeback={onTakeback} />}
      <Composer
        value={value}
        onChange={setValue}
        onSend={onSend}
        onStop={vi.fn()}
        busy={false}
        connected
        pending={[]}
        model="Swift"
        provider="llama"
        models={[]}
        onModel={vi.fn()}
        onProviders={vi.fn()}
        thinking={null}
        onThinking={vi.fn()}
        cwd="/tmp/p"
        branch=""
        sessions={[]}
        onProject={vi.fn()}
        onPickFolder={vi.fn()}
        usage={null}
        inputRef={ref}
        hero={false}
        mode="ask"
        onMode={vi.fn()}
        attachments={[]}
        onAddFiles={vi.fn()}
        onRemoveAttachment={vi.fn()}
        blocked={blocked}
        files={null}
        onNeedFiles={vi.fn()}
        commands={allCommands([])}
        pickItems={(_p: SlashPick) => null}
        onNeedPick={vi.fn()}
        onCommand={vi.fn()}
      />
    </>
  );
}

describe("session in a real pi terminal", () => {
  it("terminal_state open:true blocks the composer and shows the bar; the button takes the session back", () => {
    const state = ev(true);
    expect(state.terminalOpen).toBe(true);
    const onSend = vi.fn();
    const onTakeback = vi.fn();
    render(<Harness blocked={state.terminalOpen} onSend={onSend} onTakeback={onTakeback} />);
    expect(screen.getByText("Sesja otwarta w terminalu (pi)")).toBeTruthy();
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "hej" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Przejmij z powrotem/ })).toBeTruthy();
    fireEvent.click(screen.getByText("Przejmij z powrotem"));
    expect(onTakeback).toHaveBeenCalledTimes(1);
  });

  it("terminal_state open:false unblocks the composer and hides the bar", () => {
    let state = ev(true);
    state = reducer(state, { type: "event", event: { kind: "terminal_state", open: false }, at: Date.now() });
    expect(state.terminalOpen).toBe(false);
    const onSend = vi.fn();
    render(<Harness blocked={state.terminalOpen} onSend={onSend} onTakeback={vi.fn()} />);
    expect(screen.queryByText("Sesja otwarta w terminalu (pi)")).toBeNull();
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "hej" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
