// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { changeStats, relPath, shortPath, summarizeArgs, ToolCard } from "./tool-card";
import type { ToolItem } from "./reducer";

const base: ToolItem = { id: "t1", name: "bash", args: { command: "ls -la" }, status: "running", summary: "" };

describe("ToolCard", () => {
  it("shows spinner, verb and command while running; body collapsed", () => {
    const { container } = render(<ToolCard tool={base} />);
    expect(container.querySelector(".tool.running")).not.toBeNull();
    expect(container.querySelector(".spinner")).not.toBeNull();
    expect(screen.getByText("Polecenie")).toBeTruthy();
    expect(screen.getByText("ls -la")).toBeTruthy();
    expect(container.querySelector(".tool-body")).toBeNull();
  });

  it("expands a finished bash call into a terminal view with the output", () => {
    const { container } = render(
      <ToolCard tool={{ ...base, status: "ok", summary: "total 8", start: 0, end: 1500 }} />,
    );
    expect(container.querySelector(".spinner")).toBeNull();
    expect(container.querySelector(".tool-status.ok")).not.toBeNull();
    expect(screen.getByText("1,5 s")).toBeTruthy();
    fireEvent.click(container.querySelector(".tool-row")!);
    expect(container.querySelector(".term-cmd")?.textContent).toContain("ls -la");
    expect(screen.getByText("total 8")).toBeTruthy();
  });

  it("marks errors", () => {
    const { container } = render(<ToolCard tool={{ ...base, status: "error", summary: "boom" }} />);
    expect(container.querySelector(".tool.error")).not.toBeNull();
    expect(container.querySelector(".tool-status.error")).not.toBeNull();
  });

  it("renders an edit as a diff with +/- counts", () => {
    const edit: ToolItem = {
      id: "e1",
      name: "edit",
      args: { path: "/w/src/a.ts", edits: [{ oldText: "a\nb", newText: "c" }] },
      status: "ok",
      summary: "",
    };
    const { container } = render(<ToolCard tool={edit} cwd="/w" />);
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("−2")).toBeTruthy();
    fireEvent.click(container.querySelector(".tool-row")!);
    expect(container.querySelectorAll(".diff-del")).toHaveLength(2);
    expect(container.querySelectorAll(".diff-add")).toHaveLength(1);
  });
});

describe("tool-card helpers", () => {
  it("summarizes the first relevant arg key, truncated at 120 chars", () => {
    expect(summarizeArgs({ path: "/tmp/x" })).toBe("/tmp/x");
    expect(summarizeArgs({ command: "ls" })).toBe("ls");
    expect(summarizeArgs({ command: "ls", path: "/p" })).toBe("/p"); // path has priority over command
    expect(summarizeArgs({ command: "echo a\necho b" })).toBe("echo a"); // first line only
    expect(summarizeArgs({ url: "x".repeat(150) })).toBe(`${"x".repeat(120)}…`);
    expect(summarizeArgs({ other: "v" })).toBe("");
    expect(summarizeArgs(null)).toBe("");
  });

  it("relPath shortens cwd-relative and home paths", () => {
    expect(relPath("/w/src/a.ts", "/w")).toBe("src/a.ts");
    expect(relPath("/home/majke/x/y", "/w")).toBe("~/x/y");
    expect(relPath("/etc/hosts", "/w")).toBe("/etc/hosts");
  });

  it("shortPath keeps the last two segments of long paths", () => {
    expect(shortPath("/tmp/a/very/long/directory/name/that/goes/on/scratchpad/demo.py", "/w")).toBe("…/scratchpad/demo.py");
    expect(shortPath("/w/src/a.ts", "/w")).toBe("src/a.ts");
  });

  it("changeStats counts write lines", () => {
    expect(changeStats({ ...base, name: "write", args: { path: "f", content: "a\nb\n" } })).toEqual({ add: 2, del: 0 });
    expect(changeStats(base)).toBeNull();
  });
});
