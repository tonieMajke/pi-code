import { test } from "node:test";
import assert from "node:assert/strict";
import { PriorityQueue } from "./src/queue.mjs";
test("equal priorities keep insertion order", () => {
  const q = new PriorityQueue();
  q.push("x", 1); q.push("y", 1); q.push("z", 0);
  assert.deepEqual([q.pop(), q.pop(), q.pop()], ["z", "x", "y"]);
});
test("many items", () => {
  const q = new PriorityQueue();
  const nums = Array.from({ length: 200 }, (_, i) => (i * 37) % 200);
  for (const n of nums) q.push(n, n);
  const out = [];
  while (q.size) out.push(q.pop());
  assert.deepEqual(out, [...nums].sort((a, b) => a - b));
});
