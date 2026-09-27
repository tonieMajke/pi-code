// @vitest-environment jsdom
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "./Composer";
import { allCommands } from "../lib/slash";
import { isNoModelFailure } from "../lib/no-model";

afterEach(cleanup);

const RAW_PI_ERROR =
  "prompt: No API key found for the selected model. Use /login <provider> to set the API key. See /home/u/.pi/npm/node_modules/@earendil-works/pi-coding-agent/docs/providers.md";

function Harness({
  model = "",
  onSend = () => {},
  onProviders = () => {},
}: {
  model?: string;
  onSend?: () => void;
  onProviders?: () => void;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <Composer
      value={value}
      onChange={setValue}
      onSend={onSend}
      onStop={vi.fn()}
      busy={false}
      connected
      pending={[]}
      model={model}
      provider="llama"
      models={[]}
      onModel={vi.fn()}
      onProviders={onProviders}
      thinking={null}
      onThinking={vi.fn()}
      cwd="/tmp/p"
      branch=""
      sessions={[]}
      onProject={vi.fn()}
      onPickFolder={vi.fn()}
      usage={null}
      inputRef={ref}
      hero
      mode="ask"
      onMode={vi.fn()}
      attachments={[]}
      onAddFiles={vi.fn()}
      onRemoveAttachment={vi.fn()}
      blocked={false}
      files={null}
      onNeedFiles={vi.fn()}
      commands={allCommands([])}
      pickItems={() => null}
      onNeedPick={vi.fn()}
      onCommand={vi.fn()}
    />
  );
}

describe("composer without a model", () => {
  it("shows the hint and the setting it points to", () => {
    const onProviders = vi.fn();
    render(<Harness onProviders={onProviders} />);
    const hint = screen.getByRole("status");
    expect(hint.textContent).toContain("Nie ma modelu");
    fireEvent.click(screen.getByRole("button", { name: "dodaj dostawcę modeli" }));
    expect(onProviders).toHaveBeenCalledTimes(1);
  });

  it("neither Enter nor the send button reaches the sidecar", () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "zrób kubek" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();

    const send = screen.getByTitle("Wyślij (Enter)") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("Enter with text opens the provider setting", () => {
    const onSend = vi.fn();
    const onProviders = vi.fn();
    render(<Harness onSend={onSend} onProviders={onProviders} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "zrób kubek" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onProviders).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("a slash command with arguments still goes: /login is how a model gets there", () => {
    const onSend = vi.fn();
    const onProviders = vi.fn();
    render(<Harness onSend={onSend} onProviders={onProviders} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "/login anthropic" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onProviders).not.toHaveBeenCalled();
  });

  it("with a model, Enter sends again", () => {
    const onSend = vi.fn();
    render(<Harness model="Swift" onSend={onSend} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "zrób kubek" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("isNoModelFailure", () => {
  it("recognises pi's key/model words", () => {
    expect(isNoModelFailure(RAW_PI_ERROR)).toBe(true);
    expect(isNoModelFailure("prompt: No model selected. Set the model with /model")).toBe(true);
  });

  it("leaves every other failure to the normal error bar", () => {
    expect(isNoModelFailure("connect ECONNREFUSED 127.0.0.1:8080")).toBe(false);
    expect(isNoModelFailure("git: not a repository")).toBe(false);
  });
});
