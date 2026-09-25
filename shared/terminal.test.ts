import { describe, expect, it } from "vitest";
import { TERMINAL_PRESETS, terminalChoiceFor, terminalTemplateFor } from "./terminal";

describe("terminal presets", () => {
  it("each preset maps to its exact template", () => {
    expect(terminalTemplateFor("konsole", "")).toBe("konsole --separate --workdir {cwd} -e pi --session {session}");
    expect(terminalTemplateFor("kitty", "")).toBe("kitty --directory {cwd} pi --session {session}");
    expect(terminalTemplateFor("alacritty", "")).toBe("alacritty --working-directory {cwd} -e pi --session {session}");
  });

  it("a custom template is kept; an empty one falls back to the default (undefined)", () => {
    expect(terminalTemplateFor("custom", "wezterm start --dir {cwd} pi --session {session}")).toBe("wezterm start --dir {cwd} pi --session {session}");
    expect(terminalTemplateFor("custom", "   ")).toBeUndefined();
  });

  it("round-trips: a stored template maps back to the right selector option", () => {
    expect(terminalChoiceFor()).toBe("konsole"); // absent = the default
    expect(terminalChoiceFor(TERMINAL_PRESETS.konsole)).toBe("konsole");
    expect(terminalChoiceFor(TERMINAL_PRESETS.kitty)).toBe("kitty");
    expect(terminalChoiceFor(TERMINAL_PRESETS.alacritty)).toBe("alacritty");
    expect(terminalChoiceFor("wezterm start")).toBe("custom");
  });
});
