"""Helpers for behaviour checks: the eval harness writes .eval/transcript.json."""
import json
import subprocess
import sys


def steps():
    with open(".eval/transcript.json", encoding="utf8") as f:
        return json.load(f)


def fail(msg):
    print(f"FAIL: {msg}")
    sys.exit(1)


def changed_files():
    out = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], capture_output=True, text=True, check=True).stdout
    skip = (".eval/", "__pycache__/", "foreign.pid", "check.py", "evalrun.py")
    return [line[3:] for line in out.splitlines() if not line[3:].startswith(skip)]
