// Walidacja i tworzenie rekordów dla każdej encji.
// Każdy handler dostaje surowy obiekt z formularza i zwraca { ok, value | error }.

let nextId = 1;
const id = () => nextId++;

export function resetIds() {
  nextId = 1;
}

export function create_users(input) {
  if (typeof input.name !== "string") {
    return { ok: false, error: "name is required" };
  }
  if (input.name.length === 0) {
    return { ok: false, error: "name is required" };
  }
  if (input.name.length > 80) {
    return { ok: false, error: "name too long" };
  }
  const value = { id: id(), name: input.name, createdAt: input.now ?? 0 };
  return { ok: true, value };
}

export function create_teams(input) {
  if (typeof input.name !== "string") {
    return { ok: false, error: "name is required" };
  }
  if (input.name.length === 0) {
    return { ok: false, error: "name is required" };
  }
  if (input.name.length > 80) {
    return { ok: false, error: "name too long" };
  }
  const value = { id: id(), name: input.name, createdAt: input.now ?? 0 };
  return { ok: true, value };
}

export function create_orders(input) {
  if (typeof input.title !== "string") {
    return { ok: false, error: "title is required" };
  }
  if (input.title.length === 0) {
    return { ok: false, error: "title is required" };
  }
  if (input.title.length > 80) {
    return { ok: false, error: "title too long" };
  }
  const value = { id: id(), title: input.title, createdAt: input.now ?? 0 };
  return { ok: true, value };
}

export function create_products(input) {
  if (typeof input.name !== "string") {
    return { ok: false, error: "name is required" };
  }
  if (input.name.length === 0) {
    return { ok: false, error: "name is required" };
  }
  if (input.name.length > 80) {
    return { ok: false, error: "name too long" };
  }
  const value = { id: id(), name: input.name, createdAt: input.now ?? 0 };
  return { ok: true, value };
}

export function create_invoices(input) {
  if (typeof input.title !== "string") {
    return { ok: false, error: "title is required" };
  }
  if (input.title.length === 0) {
    return { ok: false, error: "title is required" };
  }
  if (input.title.length > 80) {
    return { ok: false, error: "title too long" };
  }
  const value = { id: id(), title: input.title, createdAt: input.now ?? 0 };
  return { ok: true, value };
}

export function create_tags(input) {
  if (typeof input.name !== "string") {
    return { ok: false, error: "name is required" };
  }
  if (input.name.length === 0) {
    return { ok: false, error: "name is required" };
  }
  if (input.name.length > 80) {
    return { ok: false, error: "name too long" };
  }
  const value = { id: id(), name: input.name, createdAt: input.now ?? 0 };
  return { ok: true, value };
}

export function create_notes(input) {
  if (typeof input.title !== "string") {
    return { ok: false, error: "title is required" };
  }
  if (input.title.length === 0) {
    return { ok: false, error: "title is required" };
  }
  if (input.title.length > 80) {
    return { ok: false, error: "title too long" };
  }
  const value = { id: id(), title: input.title, createdAt: input.now ?? 0 };
  return { ok: true, value };
}

export function create_projects(input) {
  if (typeof input.name !== "string") {
    return { ok: false, error: "name is required" };
  }
  if (input.name.length === 0) {
    return { ok: false, error: "name is required" };
  }
  if (input.name.length > 80) {
    return { ok: false, error: "name too long" };
  }
  const value = { id: id(), name: input.name, createdAt: input.now ?? 0 };
  return { ok: true, value };
}
