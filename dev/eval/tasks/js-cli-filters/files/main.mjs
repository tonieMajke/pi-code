import { parseArgs } from "./src/args.mjs";
import { load } from "./src/store.mjs";
import { applyFilters } from "./src/filter.mjs";
import { render } from "./src/format.mjs";

try {
  const opts = parseArgs(process.argv.slice(2));
  console.log(render(applyFilters(load(opts.file), opts)));
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
