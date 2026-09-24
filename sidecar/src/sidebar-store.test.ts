import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeSidebar, SidebarStore } from "./sidebar-store";

describe("sidebar store", () => {
  it("drops malformed data and keeps each chat in one group only", () => {
    expect(
      normalizeSidebar({
        groups: [{ id: "a", name: " Praca ", sessions: ["/x", "/x", 3, "/y"] }, { id: "a", name: "dup" }, { id: "b", name: "", sessions: ["/y", "/z"] }, null],
        projects: ["/p", "/p", 1],
      }),
    ).toEqual({
      groups: [
        { id: "a", name: "Praca", sessions: ["/x", "/y"] },
        { id: "b", name: "Grupa", sessions: ["/z"] },
      ],
      projects: ["/p"],
    });
    expect(normalizeSidebar("śmieci")).toEqual({ groups: [], projects: [] });
  });

  it("survives a broken file, saves, and forgets deleted chats", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-gui-sidebar-"));
    try {
      const file = join(dir, "sidebar.json");
      writeFileSync(file, "{nie json");
      const store = new SidebarStore(file);
      expect(store.get()).toEqual({ groups: [], projects: [] });
      store.set({ groups: [{ id: "g", name: "G", sessions: ["/a", "/b"] }], projects: [] });
      store.forget("/a");
      expect(JSON.parse(readFileSync(file, "utf8")).groups[0].sessions).toEqual(["/b"]);
      expect(new SidebarStore(file).get().groups[0].sessions).toEqual(["/b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
