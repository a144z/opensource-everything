"""Find statements that were joined onto one line by an editing pass.

A `*/export`, `;const`, `}export` or `*/` + word sequence on one line compiles
only by luck and hides the change in review. This lists candidates so each can
be split back onto its own line.
"""

import io
import os
import re

BASE = r"C:\Users\justin\Desktop\opensource-everything\sketchup"
PATTERNS = [
    re.compile(r"\*/(?=[A-Za-z{/])"),
    re.compile(r";\s*(?=(?:const|let|var|function|export|import|return|if|for|class|type|interface)\b)"),
    re.compile(r"\}\s*(?=(?:const|let|function|export|import|return|if|class)\b)"),
]

hits = 0
for root in (os.path.join(BASE, "packages"), os.path.join(BASE, "apps"), os.path.join(BASE, "scripts")):
    if not os.path.isdir(root):
        continue
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in {"node_modules", "dist", "target", "gen"}]
        for name in filenames:
            if not name.endswith((".ts", ".mjs")):
                continue
            path = os.path.join(dirpath, name)
            for n, line in enumerate(io.open(path, encoding="utf-8").read().split("\n"), 1):
                stripped = line.strip()
                if stripped.startswith("//") or stripped.startswith("*"):
                    continue
                for pat in PATTERNS:
                    m = pat.search(line)
                    if m:
                        print(f"{os.path.relpath(path, BASE)}:{n}: {stripped[:120]}")
                        hits += 1
                        break
print("candidates:", hits)
