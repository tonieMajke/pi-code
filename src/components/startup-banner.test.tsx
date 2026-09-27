// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { setLang } from "../../shared/i18n";
import { StartupBanner } from "./StartupBanner";

afterEach(() => {
  cleanup();
  setLang("pl");
});

const missing = { kind: "node_missing", node: "/nie/ma, node", required: "22.19.0" } as const;
const tooOld = { kind: "node_too_old", node: "/usr/bin/node", detected: "v20.0.0", required: "22.19.0" } as const;
const spawn = { kind: "spawn", error: "Permission denied (os error 13)" } as const;

const text = () => screen.getByRole("alert").textContent ?? "";

describe("StartupBanner", () => {
  it("names the binary, the required version and PI_CODE_NODE when node is missing", () => {
    render(<StartupBanner problem={missing} onDismiss={() => {}} />);
    expect(text()).toContain("/nie/ma");
    expect(text()).toContain("22.19.0");
    expect(text()).toContain("PI_CODE_NODE");
  });

  it("names the version it found when node is too old, in English", () => {
    setLang("en");
    render(<StartupBanner problem={tooOld} onDismiss={() => {}} />);
    expect(text()).toContain("Node v20.0.0");
    expect(text()).toContain("22.19.0");
    expect(text()).toContain("PI_CODE_NODE");
    expect(text()).not.toMatch(/uruchom|Zainstaluj/);
  });

  it("blames PI_CODE_NODE, not the missing install, when that variable was the only candidate", () => {
    setLang("en");
    render(<StartupBanner problem={{ ...missing, node: "/usr/bin/python3", from_env: true }} onDismiss={() => {}} />);
    expect(text()).toContain("PI_CODE_NODE points at /usr/bin/python3");
    expect(text()).not.toContain("Install Node");
  });

  it("keeps the raw spawn error in the sentence", () => {
    render(<StartupBanner problem={spawn} onDismiss={() => {}} />);
    expect(text()).toContain("Permission denied (os error 13)");
  });

  it("closes", () => {
    const onDismiss = vi.fn();
    render(<StartupBanner problem={missing} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTitle("Zamknij"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
