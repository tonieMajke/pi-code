import { describe, expect, it } from "vitest";
import { bashPrefixes, coveredByPrefixes } from "./shell";

describe("bash prefixes for “always in this session”", () => {
  it.each([
    ["pnpm test", ["pnpm test"]],
    ["pnpm test -- -t parser", ["pnpm test"]],
    ["npm run build", ["npm run build"]],
    ["pnpm exec vitest run", ["pnpm exec vitest"]],
    ["git commit -m 'x'", ["git commit"]],
    ["cd sidecar && pnpm test", ["cd", "pnpm test"]],
    ["python3 tools/gen.py --out x", ["python3 tools/gen.py"]],
    ["LANG=C make check", ["make check"]],
    ["cargo --version", ["cargo"]],
  ])("%s → %j", (cmd, prefixes) => expect(bashPrefixes(cmd)).toEqual(prefixes));

  it.each(["python3 -c 'import os'", "node -e 1", "bash -c 'rm -rf x'", "echo $(id)", "LD_PRELOAD=x.so pnpm test"])(
    "%s cannot be remembered",
    (cmd) => expect(bashPrefixes(cmd)).toBeNull(),
  );

  it("a remembered prefix covers the same command with other arguments, nothing else", () => {
    const ok = new Set(["pnpm test", "cd"]);
    expect(coveredByPrefixes("pnpm test -- -t x", ok)).toBe(true);
    expect(coveredByPrefixes("cd sidecar && pnpm test", ok)).toBe(true);
    expect(coveredByPrefixes("pnpm test && rm -rf build", ok)).toBe(false);
    expect(coveredByPrefixes("pnpm testx", ok)).toBe(false);
    expect(coveredByPrefixes("pnpm install", ok)).toBe(false);
    expect(coveredByPrefixes("pnpm test > out.txt", ok)).toBe(false); // writes a file
    expect(coveredByPrefixes("pnpm test; $(curl x)", ok)).toBe(false);
  });
});
