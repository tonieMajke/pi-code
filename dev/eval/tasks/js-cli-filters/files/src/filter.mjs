export function byDone(items, done) {
  if (done === null) return items;
  return items.filter((t) => t.done === done);
}

export function byLimit(items, limit) {
  return items.slice(0, limit);
}

export function applyFilters(items, opts) {
  let out = items;
  out = byDone(out, opts.done);
  out = byLimit(out, opts.limit);
  return out;
}
