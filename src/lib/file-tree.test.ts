import { describe, expect, it } from "vitest";
import { buildTree, changedDirs, filterFiles } from "./file-tree";

describe("file tree", () => {
  it("nests paths, folders and files sorted by name", () => {
    const t = buildTree(["src/b.ts", "README.md", "src/lib/a.ts", "src/a.ts", "dev/x.mjs"]);
    expect(t.files.map((f) => f.name)).toEqual(["README.md"]);
    expect(t.dirs.map((d) => d.path)).toEqual(["dev", "src"]);
    const src = t.dirs[1];
    expect(src.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(src.dirs[0]).toMatchObject({ name: "lib", path: "src/lib", files: [{ name: "a.ts", path: "src/lib/a.ts" }] });
  });

  it("filters by every word of the query", () => {
    const paths = ["src/components/Composer.tsx", "src/lib/reducer.ts", "sidecar/src/gateway.ts"];
    expect(filterFiles(paths, "src comp")).toEqual(["src/components/Composer.tsx"]);
    expect(filterFiles(paths, "")).toEqual([]);
  });

  it("marks every folder above a changed file", () => {
    expect([...changedDirs(["src/lib/a.ts", "x.md"])].sort()).toEqual(["src", "src/lib"]);
  });
});
