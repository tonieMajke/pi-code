import { describe, expect, it, vi } from "vitest";
import type { PiEvent, UiRequest } from "../../shared/protocol";
import { ExtensionDialogs } from "./extension-ui";

function setup() {
  const events: PiEvent[] = [];
  const dialogs = new ExtensionDialogs((e) => events.push(e));
  const ui = dialogs.context(undefined);
  const lastRequest = () => {
    const e = [...events].reverse().find((x) => x.kind === "ui_request");
    return (e as Extract<PiEvent, { kind: "ui_request" }>).request as UiRequest;
  };
  return { events, dialogs, ui, lastRequest };
}

describe("ExtensionDialogs", () => {
  it("select resolves with the option the user picked", async () => {
    const { dialogs, ui, lastRequest } = setup();
    const answer = ui.select("Serwer?", ["a", "b"]);
    const req = lastRequest();
    expect(req).toMatchObject({ method: "select", title: "Serwer?", options: ["a", "b"] });
    dialogs.answer(req.id, { value: "b" });
    await expect(answer).resolves.toBe("b");
  });

  it("confirm is true only for an explicit yes; cancel gives undefined text", async () => {
    const { dialogs, ui, lastRequest } = setup();
    const yes = ui.confirm("Usunąć?", "na pewno");
    dialogs.answer(lastRequest().id, { value: true });
    await expect(yes).resolves.toBe(true);
    const text = ui.input("Nazwa");
    dialogs.answer(lastRequest().id, { cancelled: true });
    await expect(text).resolves.toBeUndefined();
  });

  it("a timeout cancels the dialog and tells the UI to drop it", async () => {
    vi.useFakeTimers();
    try {
      const { events, ui, lastRequest } = setup();
      const answer = ui.confirm("Szybko", "?", { timeout: 1000 });
      const id = lastRequest().id;
      vi.advanceTimersByTime(1000);
      await expect(answer).resolves.toBe(false);
      expect(events).toContainEqual({ kind: "ui_done", id });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancelAll releases every waiting extension (abort, session swap)", async () => {
    const { dialogs, ui } = setup();
    const a = ui.select("x", ["1"]);
    const b = ui.editor("y", "prefill");
    dialogs.cancelAll();
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
  });

  it("an answer after cancel is ignored", async () => {
    const { dialogs, ui, lastRequest } = setup();
    const a = ui.select("x", ["1"]);
    const id = lastRequest().id;
    dialogs.cancelAll();
    dialogs.answer(id, { value: "1" });
    await expect(a).resolves.toBeUndefined();
  });

  it("notify and setEditorText reach the UI as events", () => {
    const { events, ui } = setup();
    ui.notify("pamięć: 3 wpisy");
    ui.notify("źle", "error");
    ui.setEditorText("gotowy prompt");
    expect(events).toEqual([
      { kind: "notice", level: "info", text: "pamięć: 3 wpisy" },
      { kind: "notice", level: "error", text: "źle" },
      { kind: "editor_text", text: "gotowy prompt" },
    ]);
  });
});
