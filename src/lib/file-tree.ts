/** Project file tree for the Files panel, built from files_list (git ls-files or find). */

export interface TreeDir {
  name: string;
  path: string;
  dirs: TreeDir[];
  files: { name: string; path: string }[];
}

export function buildTree(paths: string[]): TreeDir {
  const root: TreeDir = { name: "", path: "", dirs: [], files: [] };
  const index = new Map<string, TreeDir>([["", root]]);
  const dirOf = (path: string): TreeDir => {
    const hit = index.get(path);
    if (hit) return hit;
    const cut = path.lastIndexOf("/");
    const parent = dirOf(cut < 0 ? "" : path.slice(0, cut));
    const d: TreeDir = { name: path.slice(cut + 1), path, dirs: [], files: [] };
    parent.dirs.push(d);
    index.set(path, d);
    return d;
  };
  for (const p of paths) {
    const cut = p.lastIndexOf("/");
    dirOf(cut < 0 ? "" : p.slice(0, cut)).files.push({ name: p.slice(cut + 1), path: p });
  }
  const sort = (d: TreeDir) => {
    d.dirs.sort((a, b) => a.name.localeCompare(b.name));
    d.files.sort((a, b) => a.name.localeCompare(b.name));
    d.dirs.forEach(sort);
  };
  sort(root);
  return root;
}

/** Files whose path contains every word of the query (case-insensitive), at most `limit`. */
export function filterFiles(paths: string[], query: string, limit = 300): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: string[] = [];
  for (const p of paths) {
    const l = p.toLowerCase();
    if (words.every((w) => l.includes(w))) out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

/** Folders holding changed files — a collapsed folder still shows that something inside changed. */
export function changedDirs(changed: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const p of changed) {
    for (let i = p.indexOf("/"); i >= 0; i = p.indexOf("/", i + 1)) dirs.add(p.slice(0, i));
  }
  return dirs;
}
