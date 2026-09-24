// Parsowanie argumentów: node main.mjs [plik] [--done] [--limit N]
export function parseArgs(argv) {
  const opts = { file: "tasks.json", done: null, limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--done") opts.done = true;
    else if (a === "--open") opts.done = false;
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (!a.startsWith("--")) opts.file = a;
    else throw new Error(`nieznana opcja: ${a}`);
  }
  return opts;
}
