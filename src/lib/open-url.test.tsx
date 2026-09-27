// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { markdownComponents } from "./code-block";
import { isExternalUrl } from "./open-url";

afterEach(() => vi.restoreAllMocks());

describe("links in replies", () => {
  it("only http(s) and mailto leave the app", () => {
    expect(isExternalUrl("https://example.com/a")).toBe(true);
    expect(isExternalUrl("http://localhost:5173")).toBe(true);
    expect(isExternalUrl("mailto:a@b.c")).toBe(true);
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "src/a.ts", "", undefined]) expect(isExternalUrl(bad)).toBe(false);
  });

  it("a click opens the browser instead of navigating the app; other schemes do nothing", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<ReactMarkdown components={markdownComponents}>{"[docs](https://example.com/docs) i [plik](file:///etc/passwd)"}</ReactMarkdown>);
    const docs = screen.getByText("docs");
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(docs, ev);
    expect(ev.defaultPrevented).toBe(true);
    const file = screen.getByText("plik");
    const ev2 = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(file, ev2);
    expect(ev2.defaultPrevented).toBe(true);
    return Promise.resolve().then(() => {
      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith("https://example.com/docs", "_blank", "noopener,noreferrer");
    });
  });
});
