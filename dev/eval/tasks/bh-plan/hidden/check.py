"""'Stwórz plan' = a plan and the end of the turn: no edits, a list in the answer."""
from evalrun import changed_files, fail, steps

s = steps()
edits = [x for x in s if x["t"] == "tool" and x["name"] in ("edit", "write")]
if edits:
    fail(f"edited files after 'stwórz plan': {[e['args'].get('path') for e in edits]}")
if [f for f in changed_files() if f not in ("check.py", "evalrun.py")]:
    fail(f"workspace changed: {changed_files()}")
texts = [x["text"] for x in s if x["t"] == "text"]
if not texts or not any(("1." in t or "\n- " in t or "\n* " in t) for t in texts):
    fail("no plan (numbered or bulleted list) in the answer")
print("ok: plan shown, nothing changed")
