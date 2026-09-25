import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GuiConfigStore } from "./config";

describe("GuiConfigStore extensions", () => {
  it("switches an extension off and on, and keeps it across loads", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pi-gui-cfg-")), "pi-gui.json");
    const store = new GuiConfigStore(file);
    expect(store.extensionDisabled("pi-lens")).toBe(false);
    store.setExtension("pi-lens", false);
    store.setExtension("pi-lens", false);
    expect(store.get().extensions.disabled).toEqual(["pi-lens"]);
    expect(new GuiConfigStore(file).extensionDisabled("pi-lens")).toBe(true);
    store.setExtension("pi-lens", true);
    expect(JSON.parse(readFileSync(file, "utf8")).extensions.disabled).toEqual([]);
  });

  it("ignores a malformed list", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pi-gui-cfg-")), "pi-gui.json");
    writeFileSync(file, JSON.stringify({ extensions: { disabled: "pi-lens" } }));
    expect(new GuiConfigStore(file).get().extensions.disabled).toEqual([]);
  });
});
