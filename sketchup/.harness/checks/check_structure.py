import io
import os
import re

BASE = r"C:\Users\justin\Desktop\opensource-everything\sketchup"


def walk(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in {"node_modules", "dist", "target", "gen"}]
        for name in filenames:
            if name.endswith((".ts", ".mjs", ".css", ".html")):
                yield os.path.join(dirpath, name)


problems = 0

roots = [os.path.join(BASE, "packages"), os.path.join(BASE, "apps", "app", "src")]
for root in roots:
    for path in walk(root):
        text = io.open(path, encoding="utf-8").read()
        for n, line in enumerate(text.split("\n"), 1):
            # Two statements joined on one line: a `;` or `}` followed by code.
            if re.search(r"^\s*(const|let|function|export|import|return|if)\b.*;\s*(const|let|function|export|import|return|if)\b", line):
                print(f"JOINED  {os.path.relpath(path, BASE)}:{n}: {line.strip()[:110]}")
                problems += 1
            if re.search(r"\}\s*(const|let|return|export function)\b", line) and not line.strip().startswith("//"):
                print(f"JOINED? {os.path.relpath(path, BASE)}:{n}: {line.strip()[:110]}")
                problems += 1

# Duplicate exported names across the engine modules the barrel re-exports.
src = os.path.join(BASE, "packages", "engine", "src")
seen = {}
for name in os.listdir(src):
    if not name.endswith(".ts") or name == "index.ts":
        continue
    text = io.open(os.path.join(src, name), encoding="utf-8").read()
    for m in re.finditer(r"(?m)^export\s+(?:async\s+)?(?:function|const|class|interface|type|let)\s+([A-Za-z0-9_]+)", text):
        seen.setdefault(m.group(1), []).append(name)
dups = {k: v for k, v in seen.items() if len(v) > 1}
print("duplicate exports:", dups or "none")
print("join problems:", problems)
