import json
import re

p = r"C:\Users\justin\Desktop\opensource-everything\sketchup\specs\commands.json"
d = json.load(open(p, encoding="utf-8"))
block = next(b for b in d["blocks"] if b.get("shape") == "command_set")
seen = {}
for f in block["fields"]:
    k = f.get("key")
    if not k:
        continue
    norm = k.lower()
    if norm in seen:
        print("CLASH:", norm, seen[norm], f["name"])
    seen[norm] = f["name"]
print("total keys:", len(seen))
for f in block["fields"]:
    if f["name"] in ("polygon", "toggleXray"):
        print(f["name"], "=", f.get("key"))
