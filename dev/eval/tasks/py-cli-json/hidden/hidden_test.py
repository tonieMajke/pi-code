import json, subprocess, sys
open("sample.txt", "w", encoding="utf-8").write("ala ma\nkota\n")
out = subprocess.run([sys.executable, "wc.py", "sample.txt", "--json"], capture_output=True, text=True, check=True).stdout
assert json.loads(out) == {"lines": 2, "words": 3, "chars": 12}, out
plain = subprocess.run([sys.executable, "wc.py", "sample.txt"], capture_output=True, text=True, check=True).stdout
assert plain.strip() == "2 3 12 sample.txt", plain
print("OK")
