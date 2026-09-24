import { stat } from "node:fs/promises";

export async function totalSize(paths) {
  let total = 0;
  paths.forEach(async (p) => {
    const s = await stat(p);
    total += s.size;
  });
  return total;
}
