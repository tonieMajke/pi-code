import { describe, expect, it } from "vitest";
import { appContext } from "./app-context.js";

describe("appContext", () => {
  it("tells the model where it runs, and names the sources only for a checkout", () => {
    expect(appContext("/src/pi-gui")).toMatch(/inside Pi Code[\s\S]*\/src\/pi-gui[\s\S]*end your turn[\s\S]*\/handoff/);
    expect(appContext(null)).not.toMatch(/sources/);
  });
});
