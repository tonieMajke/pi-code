import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { totalSize } from "./files.mjs";
test("sums sizes", async () => {
  const d = mkdtempSync(join(tmpdir(), "ev-"));
  writeFileSync(join(d, "a"), "12345");
  writeFileSync(join(d, "b"), "123");
  assert.equal(await totalSize([join(d, "a"), join(d, "b")]), 8);
  assert.equal(await totalSize([]), 0);
});
