import { describe, expect, it } from "vitest";
import { decide, foreignKill, isReadOnlyCommand, OWNER_ENV, startedByApp } from "./permissions";

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

describe("foreignKill", () => {
  const own = new Set([111, 222]);
  const isOwn = (pid: number) => own.has(pid);
  it.each([
    "kill 111",
    "kill -9 111 222",
    "kill -s TERM 111",
    "godot --path . & sleep 5; kill $!",
    "sleep 100 & PID=$!; sleep 1; kill $PID",
    "kill %1",
    "kill -l",
    "ls -la && echo done",
    "grep -n kill src/a.ts",
    "timeout 5 kill 111",
    "npm test 2>&1 | tail",
  ])("lets through %s", (c) => expect(foreignKill(c, isOwn)).toBeNull());

  it.each([
    ["kill -9 419870", /419870/],
    ["kill 111 419870", /419870/],
    ["pkill -f \"godot --path\"", /pkill/],
    ["killall godot", /killall/],
    ["kill $(pgrep godot)", /another command/],
    ["kill `pidof godot`", /another command/],
    ["pgrep godot | xargs kill", /another command/],
    ["PID=$(pgrep godot); kill $PID", /variable/],
    ["kill -- -111", /process group/],
    ["kill -9 -1", /process group/],
    ["fuser -k 8080/tcp", /fuser/],
    ["bash -c 'kill 5'", /PID 5/],
    ["sudo /usr/bin/kill 5", /PID 5/],
  ])("stops %s", (c, why) => expect(foreignKill(c, isOwn)).toMatch(why));
});

describe("startedByApp", () => {
  it("recognises children that inherit the marker, not other processes", async () => {
    const { spawn } = await import("node:child_process");
    const mine = spawn("sleep", ["30"], { env: { ...process.env, [OWNER_ENV]: String(process.pid) } });
    const theirs = spawn("sleep", ["30"], { env: { ...process.env, [OWNER_ENV]: "1" } });
    try {
      expect(startedByApp(mine.pid!)).toBe(true);
      expect(startedByApp(theirs.pid!)).toBe(false);
      expect(startedByApp(1)).toBe(false);
      expect(startedByApp(999999999)).toBe(false);
    } finally {
      mine.kill();
      theirs.kill();
    }
  });
});
