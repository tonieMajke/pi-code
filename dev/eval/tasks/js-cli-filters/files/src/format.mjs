export function line(t) {
  const box = t.done ? "[x]" : "[ ]";
  const due = t.due ? ` (do ${t.due})` : "";
  const tags = t.tags.length ? ` #${t.tags.join(" #")}` : "";
  return `${box} ${t.id}. ${t.title}${due}${tags}`;
}

export function render(items) {
  if (items.length === 0) return "brak zadań";
  return items.map(line).join("\n");
}
