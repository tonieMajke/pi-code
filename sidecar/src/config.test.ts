import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { GuiConfigStore } from "./config";
import { BrokenJsonError, readJsonObject, writeJsonAtomic } from "./json-file";
import { VoiceStore } from "./voice";

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

describe("pi-gui.json writes", () => {
  const fresh = () => join(mkdtempSync(join(tmpdir(), "pi-gui-cfg-")), "pi-gui.json");

  it("config and voice keep each other's keys and whatever else is in the file", () => {
    const file = fresh();
    writeFileSync(file, JSON.stringify({ future: { x: 1 } }));
    const config = new GuiConfigStore(file);
    const voice = new VoiceStore(file);
    voice.update({ language: "en" });
    config.update("review", { enabled: false });
    voice.update({ model: "whisper-x" });
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.future).toEqual({ x: 1 });
    expect(raw.review.enabled).toBe(false);
    expect(raw.voice).toMatchObject({ language: "en", model: "whisper-x" });
    expect(readdirSync(dirname(file))).toEqual(["pi-gui.json"]); // no temp file left behind
  });

  it("a broken file is never overwritten: a .bak copy and an error instead", () => {
    const file = fresh();
    const broken = '{ "review": { "enabled": false }, "voice": { "language": "pl" }, ';
    writeFileSync(file, broken);
    const config = new GuiConfigStore(file);
    expect(config.broken?.message).toMatch(/pi-gui\.json nie jest poprawnym JSON-em/);
    expect(() => config.update("review", { enabled: true })).toThrow(BrokenJsonError);
    expect(() => new VoiceStore(file).update({ language: "en" })).toThrow(BrokenJsonError);
    expect(readFileSync(file, "utf8")).toBe(broken);
    expect(readFileSync(`${file}.bak`, "utf8")).toBe(broken);
  });

  it("a missing file is created; a non-object counts as broken", () => {
    const file = fresh();
    expect(readJsonObject(file)).toEqual({});
    writeJsonAtomic(file, { a: 1 }, 0o600);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, "[1,2]");
    expect(() => readJsonObject(file)).toThrow(BrokenJsonError);
  });
});
