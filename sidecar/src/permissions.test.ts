import { describe, expect, it } from "vitest";
import { decide, isReadOnlyCommand } from "./permissions";

describe("isReadOnlyCommand", () => {
  it.each([
    "ls -la",
    "cat a.txt | grep foo | wc -l",
    "git status && git diff --stat",
    "rg TODO src 2>/dev/null",
    "find . -name '*.ts'",
    "sed -n 1,20p file",
    "LANG=C sort x",
    "nvidia-smi",
  ])("allows %s", (c) => expect(isReadOnlyCommand(c)).toBe(true));

  it.each([
    "rm -rf build",
    "cat x > y",
    "echo hi >> log",
    "cat script | sh",
    "ls; rm x",
    "ls && touch x",
    "git commit -m x",
    "sed -i s/a/b/ f",
    "find . -name x -delete",
    "echo $(rm x)",
    "curl -o out http://x",
    "python3 script.py",
    "",
  ])("rejects %s", (c) => expect(isReadOnlyCommand(c)).toBe(false));
});

describe("decide", () => {
  const bash = (command: string) => ({ command });
  it("yolo allows everything", () => {
    expect(decide("yolo", "bash", bash("rm -rf /tmp/x"))).toEqual({ kind: "allow" });
  });
  it("read-only tools never ask", () => {
    for (const m of ["ask", "acceptEdits", "plan"] as const) expect(decide(m, "read", {}).kind).toBe("allow");
  });
  it("ask mode asks for edits and non-read-only bash", () => {
    expect(decide("ask", "edit", {}).kind).toBe("ask");
    expect(decide("ask", "bash", bash("pnpm test")).kind).toBe("ask");
    expect(decide("ask", "bash", bash("git status")).kind).toBe("allow");
  });
  it("acceptEdits auto-allows edit/write but still asks for bash", () => {
    expect(decide("acceptEdits", "write", {}).kind).toBe("allow");
    expect(decide("acceptEdits", "bash", bash("pnpm build")).kind).toBe("ask");
  });
  it("plan blocks writes and mutating bash, unknown tools too", () => {
    expect(decide("plan", "edit", {}).kind).toBe("block");
    expect(decide("plan", "bash", bash("pnpm install")).kind).toBe("block");
    expect(decide("plan", "bash", bash("ls")).kind).toBe("allow");
    expect(decide("plan", "subagent", {}).kind).toBe("block");
  });
});
