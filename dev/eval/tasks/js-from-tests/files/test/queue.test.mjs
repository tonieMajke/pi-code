import { test } from "node:test";
import assert from "node:assert/strict";
import { PriorityQueue } from "../src/queue.mjs";
test("pops lowest priority first", () => {
  const q = new PriorityQueue();
  q.push("c", 3);
  q.push("a", 1);
  q.push("b", 2);
  assert.equal(q.size, 3);
  assert.equal(q.pop(), "a");
  assert.equal(q.peek(), "b");
  assert.equal(q.pop(), "b");
  assert.equal(q.pop(), "c");
  assert.equal(q.pop(), undefined);
  assert.equal(q.size, 0);
});
