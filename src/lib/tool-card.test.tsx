// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { summarizeArgs, ToolCard } from "./tool-card";
import type { ToolItem } from "./reducer";

const base: ToolItem = { id: "t1", name: "bash", args: { command: "ls -la" }, status: "running", summary: "" };

describe("ToolCard", () => {
  it("shows spinner and 'wykonywanie…' while running", () => {
    const { container } = render(<ToolCard tool={base} />);
    expect(container.querySelector(".tool.running")).not.toBeNull();
    expect(container.querySelector(".spinner")).not.toBeNull();
    expect(screen.getByText("wykonywanie…")).toBeTruthy();
    expect(screen.getByText("ls -la")).toBeTruthy();
  });

  it("shows summary and no spinner when ok", () => {
    const { container } = render(<ToolCard tool={{ ...base, status: "ok", summary: "total 8" }} />);
    expect(container.querySelector(".tool.running")).toBeNull();
    expect(container.querySelector(".spinner")).toBeNull();
    expect(screen.getByText("total 8")).toBeTruthy();
  });

  it("shows the error badge when error", () => {
    const { container } = render(<ToolCard tool={{ ...base, status: "error", summary: "boom" }} />);
    expect(container.querySelector(".tool.error")).not.toBeNull();
    expect(screen.getByText("błąd")).toBeTruthy();
  });

  it("summarizes the first relevant arg key, truncated at 120 chars", () => {
    expect(summarizeArgs({ path: "/tmp/x" })).toBe("/tmp/x");
    expect(summarizeArgs({ command: "ls" })).toBe("ls");
    expect(summarizeArgs({ command: "ls", path: "/p" })).toBe("/p"); // path has priority over command
    expect(summarizeArgs({ url: "x".repeat(150) })).toBe(`${"x".repeat(120)}…`);
    expect(summarizeArgs({ other: "v" })).toBe("");
    expect(summarizeArgs(null)).toBe("");
  });
});
