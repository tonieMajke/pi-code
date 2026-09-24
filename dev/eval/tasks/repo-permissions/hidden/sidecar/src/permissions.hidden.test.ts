import { describe, expect, it } from "vitest";
import { decide, isReadOnlyCommand } from "./permissions.js";

describe("redirects write files", () => {
  it.each(["echo hi > notes.txt", "cat a.txt >> b.txt", "ls 1> out.log", "grep x a > /tmp/x", "echo a>b"])("asks for %s", (c) => {
    expect(isReadOnlyCommand(c)).toBe(false);
    expect(decide("default", "bash", { command: c })).toEqual({ kind: "ask" });
  });
  it.each(["rg TODO src 2>/dev/null", "ls >/dev/null 2>&1", "cat a 2>&1 | head", "git status 2> /dev/null"])("still allows %s", (c) => {
    expect(isReadOnlyCommand(c)).toBe(true);
  });
});
