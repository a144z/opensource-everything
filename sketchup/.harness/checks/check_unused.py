import io
import os
import re

src = r"C:\Users\justin\Desktop\opensource-everything\sketchup\apps\app\src"

for name in sorted(os.listdir(src)):
    if not name.endswith(".ts"):
        continue
    text = io.open(os.path.join(src, name), encoding="utf-8", newline="").read()
    body = text
    unused = []
    for m in re.finditer(r"import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*\"[^\"]+\";?", text, re.S):
        clause = m.group(1)
        body = body.replace(m.group(0), "")
        for part in clause.split(","):
            part = part.strip()
            if not part:
                continue
            local = part.split(" as ")[-1].strip()
            if not re.search(r"(?<![\w$.])" + re.escape(local) + r"(?![\w$])", body):
                unused.append(local)
    # Namespace imports (`import * as THREE`) are used as `NS.member`.
    for m in re.finditer(r"import\s+\*\s+as\s+([A-Za-z_$][\w$]*)", text):
        ns = m.group(1)
        if not re.search(re.escape(ns) + r"\.", body):
            unused.append("* as " + ns)
    if unused:
        print(name, "-> unused:", ", ".join(sorted(set(unused))))
