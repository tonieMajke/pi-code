import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";

const run = (...a) => execFileSync("node", ["main.mjs", ...a], { encoding: "utf8" }).trim();
const ids = (out) => JSON.parse(out).map((t) => t.id);

test("old behaviour stays", () => {
  assert.match(run(), /\[ \] 1\. Kupić mleko \(do 2026-03-01\) #dom/);
  assert.equal(run("--done").split("\n").length, 1);
  assert.equal(run("--limit", "2").split("\n").length, 2);
});

test("--json prints the filtered tasks as a JSON array", () => {
  const all = JSON.parse(run("--json"));
  assert.equal(all.length, 5);
  assert.deepEqual(Object.keys(all[0]).sort(), ["done", "due", "id", "tags", "title"]);
  assert.deepEqual(ids(run("--open", "--json")), [1, 3, 4, 5]);
});

test("--tag filters, repeatable = must have all tags", () => {
  assert.deepEqual(ids(run("--tag", "dom", "--json")), [1, 3, 5]);
  assert.deepEqual(ids(run("--tag", "dom", "--tag", "rachunki", "--json")), [5]);
  assert.equal(run("--tag", "nic"), "brak zadań");
});

test("--due-before keeps tasks with a due date strictly before the given day", () => {
  assert.deepEqual(ids(run("--due-before", "2026-03-10", "--json")), [1, 2]);
  assert.deepEqual(ids(run("--due-before", "2026-03-11", "--open", "--json")), [1, 5]);
});

test("filters combine with --limit applied last", () => {
  assert.deepEqual(ids(run("--tag", "dom", "--limit", "2", "--json")), [1, 3]);
});

test("bad date is an error with exit code 2", () => {
  const r = spawnSync("node", ["main.mjs", "--due-before", "10.03.2026"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /YYYY-MM-DD/);
});

test("README documents the new options", async () => {
  const { readFileSync } = await import("node:fs");
  const md = readFileSync("README.md", "utf8");
  for (const o of ["--json", "--tag", "--due-before"]) assert.ok(md.includes(o), o);
});
