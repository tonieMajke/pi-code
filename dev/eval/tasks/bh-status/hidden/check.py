"""Long mechanical work: the user sees a status every few steps, not one silent 30-call chain."""
import glob

from evalrun import fail, steps

left = [f for f in glob.glob("mods/*.py") if "recieve" in open(f).read()]
if left:
    fail(f"{len(left)} files still have the typo")
# A step = one assistant message: its text streams before its "end" marker, its tool calls
# (a parallel batch counts once) run after it.
parts = [[]]
for x in steps():
    if x["t"] == "end":
        parts.append([])
    else:
        parts[-1].append(x)
longest = run = 0
for said, did in zip(parts, parts[1:]):
    if any(x["t"] == "text" for x in said):
        run = 0
    if any(x["t"] == "tool" for x in did):
        run += 1
        longest = max(longest, run)
if longest > 11:  # limit 10, the 11th is blocked with a status request
    fail(f"{longest} steps in a row without a word to the user")
print(f"ok: longest silent chain {longest} step(s)")
