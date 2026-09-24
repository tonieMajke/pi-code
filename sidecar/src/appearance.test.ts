import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppearanceStore } from "./appearance";

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("AppearanceStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-gui-appearance-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("starts from defaults without a file", () => {
    expect(new AppearanceStore(dir).get()).toEqual({
      theme: "system",
      accent: null,
      background: null,
      image: { dim: 0.55, blur: 0 },
      imageUrl: null,
    });
  });

  it("persists a patch and reloads it", () => {
    new AppearanceStore(dir).update({ theme: "light", accent: "#AA3366", image: { blur: 8 } });
    const a = new AppearanceStore(dir).get();
    expect(a).toMatchObject({ theme: "light", accent: "#aa3366", image: { dim: 0.55, blur: 8 } });
  });

  it("rejects bad values and keeps the previous ones", () => {
    const s = new AppearanceStore(dir);
    s.update({ accent: "#112233" });
    const a = s.update({ accent: "red", theme: "neon" as never, image: { dim: 7, blur: -3 } });
    expect(a).toMatchObject({ accent: "#112233", theme: "system", image: { dim: 0.95, blur: 0 } });
  });

  it("null clears a colour back to the theme default", () => {
    const s = new AppearanceStore(dir);
    s.update({ background: "#101010" });
    expect(s.update({ background: null }).background).toBeNull();
  });

  it("stores the picture as a file and returns it as a data URL", () => {
    const s = new AppearanceStore(dir);
    expect(s.setImage(PNG_1PX).imageUrl).toBe(PNG_1PX);
    expect(new AppearanceStore(dir).get().imageUrl).toBe(PNG_1PX);
    // the JSON stays small: no base64 inside
    expect(readFileSync(join(dir, "pi-gui-appearance.json"), "utf8")).not.toContain("base64");
    expect(s.setImage(null).imageUrl).toBeNull();
    expect(existsSync(join(dir, "pi-gui-background"))).toBe(false);
  });

  it("refuses something that is not an image data URL", () => {
    expect(() => new AppearanceStore(dir).setImage("data:text/html;base64,PGgxPg==")).toThrow();
  });

  it("survives a corrupt file", () => {
    writeFileSync(join(dir, "pi-gui-appearance.json"), "{nope");
    expect(new AppearanceStore(dir).get().theme).toBe("system");
  });
});
