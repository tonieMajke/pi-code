import { describe, expect, it } from "vitest";
import { allCommands, BUILTINS, matchCommands, matchPicks, parseSlash, slashState } from "./slash";

const cmds = allCommands([
  { name: "memory", description: "Show persistent user memory", source: "extension" },
  { name: "compact", description: "extension trying to shadow a built-in", source: "extension" },
  { name: "review-loop", description: "Review until clean", source: "prompt" },
  { name: "skill:3d-models", description: "Modele 3D", source: "skill" },
]);

describe("slash commands", () => {
  it("parses a command with and without arguments", () => {
    expect(parseSlash("/compact")).toEqual({ name: "compact", args: "" });
    expect(parseSlash("  /compact zostaw decyzje  ")).toEqual({ name: "compact", args: "zostaw decyzje" });
    expect(parseSlash("/skill:3d-models zrób kubek")).toEqual({ name: "skill:3d-models", args: "zrób kubek" });
    expect(parseSlash("/name Nowa\nnazwa")).toEqual({ name: "name", args: "Nowa\nnazwa" });
  });

  it("does not treat paths or plain text as commands", () => {
    expect(parseSlash("/home/majke/plik.txt co to jest?")).toBeNull();
    expect(parseSlash("zrób /compact")).toBeNull();
    expect(parseSlash("/")).toBeNull();
  });

  it("built-ins win over a pi command with the same name; pi commands keep their source", () => {
    expect(cmds.filter((c) => c.name === "compact")).toHaveLength(1);
    expect(cmds.find((c) => c.name === "compact")?.kind).toBe("gui");
    expect(cmds.find((c) => c.name === "memory")?.kind).toBe("extension");
    expect(cmds.find((c) => c.name === "review-loop")).toMatchObject({ kind: "prompt", args: "[tekst]" });
    expect(cmds.at(-1)?.kind).toBe("terminal");
  });

  it("popup: list while typing the name, picker after a space for pick commands", () => {
    expect(slashState("/", cmds)).toEqual({ kind: "list", query: "" });
    expect(slashState("/mo", cmds)).toEqual({ kind: "list", query: "mo" });
    expect(slashState("/model qw", cmds)).toMatchObject({ kind: "pick", query: "qw", entry: { name: "model" } });
    expect(slashState("/compact coś", cmds)).toBeNull();
    expect(slashState("tekst /mo", cmds)).toBeNull();
  });

  it("ranks name prefix over substring over description", () => {
    const names = matchCommands(cmds, "mo").map((c) => c.name);
    expect(names.slice(0, 2)).toEqual(["model", "mode"]);
    expect(names).toContain("skill:3d-models");
    expect(matchCommands(cmds, "persistent").map((c) => c.name)).toEqual(["memory"]);
    expect(matchCommands(cmds, "")).toHaveLength(cmds.length);
  });

  it("filters picker items by label or key", () => {
    const items = [
      { key: "llama/Swift-Qwen", label: "Swift-Qwen" },
      { key: "llama/Tiel-Coder", label: "Tiel-Coder" },
    ];
    expect(matchPicks(items, "tiel").map((i) => i.key)).toEqual(["llama/Tiel-Coder"]);
    expect(matchPicks(items, " ")).toHaveLength(2);
  });

  it("every built-in with a picker also accepts a typed argument", () => {
    for (const c of BUILTINS.filter((b) => b.pick && b.name !== "fork")) expect(c.args).toBeTruthy();
  });
});
