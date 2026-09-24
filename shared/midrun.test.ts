import { describe, expect, it } from "vitest";
import { MIDRUN_NOTE, stripMidrunNote, withMidrunNote } from "./midrun";

describe("mid-run note", () => {
  it("asks the model for a visible reply and disappears again for the GUI", () => {
    const sent = withMidrunNote("co tam?");
    expect(sent).toMatch(/Reply to it first in visible text/);
    expect(stripMidrunNote(sent)).toBe("co tam?");
    expect(stripMidrunNote("zwykła wiadomość")).toBe("zwykła wiadomość");
    expect(MIDRUN_NOTE.startsWith("\n\n")).toBe(true);
  });
});
