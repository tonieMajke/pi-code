import { test } from "node:test";
import assert from "node:assert/strict";
import * as h from "./handlers.mjs";

const TRIMMED = [["users", "name"], ["orders", "title"], ["invoices", "title"]];
const UNTOUCHED = [["teams", "name"], ["products", "name"], ["tags", "name"], ["notes", "title"], ["projects", "name"]];

test("trimmed entities trim and reject blank", () => {
  for (const [e, f] of TRIMMED) {
    const r = h[`create_${e}`]({ [f]: "  Ala  " });
    assert.equal(r.ok, true, e);
    assert.equal(r.value[f], "Ala", e);
    assert.deepEqual(h[`create_${e}`]({ [f]: "   " }), { ok: false, error: `${f} is required` }, e);
    assert.equal(h[`create_${e}`]({ [f]: " " + "x".repeat(80) + " " }).ok, true, `${e}: length counts after trim`);
    assert.deepEqual(h[`create_${e}`]({ [f]: "x".repeat(81) }), { ok: false, error: `${f} too long` }, e);
  }
});

test("other entities are unchanged", () => {
  for (const [e, f] of UNTOUCHED) {
    const r = h[`create_${e}`]({ [f]: "  Ala  " });
    assert.equal(r.value[f], "  Ala  ", e);
    assert.equal(h[`create_${e}`]({ [f]: "   " }).ok, true, e);
    assert.deepEqual(h[`create_${e}`]({}), { ok: false, error: `${f} is required` }, e);
  }
});
