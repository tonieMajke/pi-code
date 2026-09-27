#!/usr/bin/env python3
"""Append t() keys to shared/i18n-en.ts; keys that already have an entry are skipped.

  python3 dev/i18n-add.py pairs.json        # pairs.json = [["pl", "en"], ...]

i18n.test.ts fails on a t("…") literal with no entry here, so this only saves typing: run the
test after, it is the check.
"""
import json
import sys

PATH = "shared/i18n-en.ts"


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    try:
        with open(sys.argv[1], encoding="utf8") as f:
            pairs = json.load(f)
        with open(PATH, encoding="utf8") as f:
            src = f.read()
    except (OSError, json.JSONDecodeError) as e:
        print(f"i18n-add: {e}")
        return 1

    have = set()
    for line in src.splitlines():
        s = line.strip()
        if s.startswith('"') and '": ' in s:
            try:
                have.add(json.loads(s[: s.index('": ') + 1]))
            except json.JSONDecodeError:
                continue  # a wrapped value line, not a key

    missing = [[pl, en] for pl, en in pairs if pl not in have]
    add = "".join(
        "  " + json.dumps(pl, ensure_ascii=False) + ": " + json.dumps(en, ensure_ascii=False) + ",\n"
        for pl, en in missing
    )
    idx = src.rstrip().rfind("};")
    try:
        with open(PATH, "w", encoding="utf8") as f:
            f.write(src[:idx] + add + src[idx:])
    except OSError as e:
        print(f"i18n-add: {e}")
        return 1
    print(f"added {len(missing)}, skipped {len(pairs) - len(missing)} existing")
    return 0


sys.exit(main())
