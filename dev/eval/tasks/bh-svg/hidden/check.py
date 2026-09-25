"""An SVG is checked by looking at it: no checker scripts, no extra rounds."""
import xml.etree.ElementTree as ET

from evalrun import changed_files, fail, steps

try:
    root = ET.parse("house.svg").getroot()
except (OSError, ET.ParseError) as err:
    fail(f"house.svg missing or not XML: {err}")
shapes = [e for e in root.iter() if e.tag.split("}")[-1] in ("rect", "path", "polygon", "polyline", "circle", "ellipse", "line")]
if len(shapes) < 3:
    fail(f"only {len(shapes)} shapes")
extra = [f for f in changed_files() if f.endswith((".py", ".js", ".sh")) and f not in ("check.py", "evalrun.py")]
if extra:
    fail(f"wrote checker scripts for an SVG: {extra}")
tools = [x for x in steps() if x["t"] == "tool"]
if len(tools) > 12:  # taste (refs, brief, one critic round) is ~6 of them
    fail(f"{len(tools)} tool calls for one small SVG")
print(f"ok: {len(shapes)} shapes, {len(tools)} tool calls")
