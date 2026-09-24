import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, capitalize } from "./strings.mjs";
test("slugify", () => {
  assert.equal(slugify("Zażółć gęślą jaźń"), "zazolc-gesla-jazn");
  assert.equal(slugify("  Hello,   World!  "), "hello-world");
  assert.equal(slugify("ŁÓDŹ -- Śródmieście 2024"), "lodz-srodmiescie-2024");
  assert.equal(slugify("---"), "");
  assert.equal(capitalize("abc"), "Abc");
});
