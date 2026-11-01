import io
import os
import re

root = r"C:\Users\justin\Desktop\opensource-everything\sketchup"

# 1. Every symbol the new tests import must be exported by the module they name.
problems = []


def exports_of(text):
    names = set()
    for m in re.finditer(r"export\s+(?:async\s+)?(?:function|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)", text):
        names.add(m.group(1))
    for m in re.finditer(r"export\s*(?:type\s+)?\{([^}]*)\}", text):
        for part in m.group(1).split(","):
            part = re.sub(r"^\s*type\s+", "", part.strip())
            if part:
                names.add(part.split(" as ")[-1].strip())
    for m in re.finditer(r'export\s+\*\s+from\s*"\./([\w.]+)\.js"', text):
        sub = os.path.join(os.path.dirname(cur_file), m.group(1) + ".ts")
        if os.path.exists(sub):
            names |= exports_of(io.open(sub, encoding="utf-8").read())
    return names


cur_file = ""


def resolve(folder, target):
    """`../src/x.js` from `apps/app/test` -> the `.ts` file on disk."""
    base = os.path.normpath(os.path.join(folder, target))
    for cand in (base, base[:-3] + ".ts" if base.endswith(".js") else base, base + ".ts"):
        if os.path.exists(cand):
            return cand
    return None


for d in ["apps/app/test", "packages/geometry/test", "packages/engine/test"]:
    folder = os.path.join(root, d)
    if not os.path.isdir(folder):
        continue
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".test.ts"):
            continue
        path = os.path.join(folder, name)
        text = io.open(path, encoding="utf-8", newline="").read()
        for m in re.finditer(r'import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"(\.[^"]+)"', text):
            resolved = resolve(folder, m.group(2))
            if resolved is None:
                problems.append(f"{d}/{name}: missing {m.group(2)}")
                continue
            cur_file = resolved
            have = exports_of(io.open(resolved, encoding="utf-8").read())
            for w in [p.strip() for p in m.group(1).split(",") if p.strip()]:
                w = re.sub(r"^\s*type\s+", "", w).split(" as ")[0].strip()
                if w not in have:
                    problems.append(f"{d}/{name}: {os.path.relpath(resolved, root)} does not export {w}")

print("test import problems:", len(problems))
for p in problems:
    print(" -", p)
