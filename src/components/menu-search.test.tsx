// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Menu, filterMenuItems, type MenuItem } from "./Menu";
import { groupByProvider, providerLabel } from "../lib/providers";

afterEach(cleanup);

const models = [
  { provider: "llama-server", id: "Swift1.5-Qwen3.8-27B-Q6_K-2GPU" },
  { provider: "openrouter", id: "anthropic/claude-sonnet-5" },
  { provider: "freetoken", id: "Swift-Flash-Next-NVFP4" },
  { provider: "openrouter", id: "qwen/qwen3-coder" },
  { provider: "llama-server", id: "Flash-Next-Q4_K_XL" },
];

function items(onPick = vi.fn()): MenuItem[] {
  const list: MenuItem[] = groupByProvider(models).map((m) => ({
    key: `${m.provider}/${m.id}`,
    label: m.id,
    group: providerLabel(m.provider),
    search: `${m.id} ${m.provider}`,
    onSelect: () => onPick(m.id),
  }));
  list.push({ key: "__providers", label: "Providers…", keep: true, onSelect: () => onPick("providers") });
  return list;
}

function open(onPick = vi.fn()) {
  render(<Menu trigger={<span>model</span>} items={items(onPick)} searchPlaceholder="Search" emptyText="Nothing" />);
  fireEvent.click(screen.getByText("model"));
  return { onPick, box: screen.getByPlaceholderText("Search") as HTMLInputElement };
}

const labels = () => [...document.querySelectorAll(".menu-item .menu-label")].map((e) => e.textContent);
const groups = () => [...document.querySelectorAll(".menu-group")].map((e) => e.textContent);

describe("model menu: groups and search", () => {
  it("keeps a provider's models together, in the order providers first appear", () => {
    expect(groupByProvider(models).map((m) => m.id)).toEqual([
      "Swift1.5-Qwen3.8-27B-Q6_K-2GPU",
      "Flash-Next-Q4_K_XL",
      "anthropic/claude-sonnet-5",
      "qwen/qwen3-coder",
      "Swift-Flash-Next-NVFP4",
    ]);
    expect(providerLabel("llama-server")).toBe("llama.cpp");
    expect(providerLabel("my-box")).toBe("my-box");
  });

  it("shows one header per provider", () => {
    open();
    expect(groups()).toEqual(["llama.cpp", "OpenRouter", "FreeToken"]);
  });

  it("filters by every word, in the model name or the provider", () => {
    const f = (q: string) => filterMenuItems(items(), q).map((i) => i.key);
    expect(f("swift")).toEqual(["llama-server/Swift1.5-Qwen3.8-27B-Q6_K-2GPU", "freetoken/Swift-Flash-Next-NVFP4", "__providers"]);
    expect(f("openrouter qwen")).toEqual(["openrouter/qwen/qwen3-coder", "__providers"]);
    expect(f("FLASH freetoken")).toEqual(["freetoken/Swift-Flash-Next-NVFP4", "__providers"]);
  });

  it("types to filter, Enter picks the first match, arrows move", () => {
    const { onPick, box } = open();
    fireEvent.change(box, { target: { value: "flash" } });
    expect(labels()).toEqual(["Flash-Next-Q4_K_XL", "Swift-Flash-Next-NVFP4", "Providers…"]);
    expect(groups()).toEqual(["llama.cpp", "FreeToken"]);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("Swift-Flash-Next-NVFP4");
    expect(screen.queryByPlaceholderText("Search")).toBeNull(); // closed
  });

  it("says so when nothing matches; Esc clears the query before closing", () => {
    const { onPick, box } = open();
    fireEvent.change(box, { target: { value: "gpt-9" } });
    expect(screen.getByText("Nothing")).toBeTruthy();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(box.value).toBe("");
    expect(labels()).toHaveLength(6);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByPlaceholderText("Search")).toBeNull();
  });
});
