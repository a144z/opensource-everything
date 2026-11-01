import io
import os
import re

root = r"C:\Users\justin\Desktop\opensource-everything\sketchup"
dirs = [
    "packages/geometry/src",
    "packages/kernel/src",
    "packages/engine/src",
    "apps/app/src",
]

problems = []


def exports_of(text):
    names = set()
    for m in re.finditer(r"export\s+(?:async\s+)?(?:function|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)", text):
        names.add(m.group(1))
    for m in re.finditer(r"export\s*(?:type\s+)?\{([^}]*)\}", text):
        for part in m.group(1).split(","):
            part = part.strip()
            if not part:
                continue
            part = re.sub(r"^\s*type\s+", "", part)
            names.add(part.split(" as ")[-1].strip())
    return names


for d in dirs:
    path = os.path.join(root, d)
    files = {}
    for name in os.listdir(path):
        if name.endswith(".ts"):
            files[name[:-3]] = io.open(os.path.join(path, name), encoding="utf-8", newline="").read()
    exported = {mod: exports_of(text) for mod, text in files.items()}
    for mod, text in files.items():
        for m in re.finditer(r'export\s+\*\s+from\s+"\./([\w.]+)\.js"', text):
            target = m.group(1)
            if target in exported:
                exported[mod] |= exported[target]
        # Local re-export lists already handled by exports_of.
        # Resolve names a module imports as aliases re-exported through another
        # module, e.g. `import { x } from "./y.js"; export { x };`.
        for m in re.finditer(r'import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"\./([\w.]+)\.js"', text):
            for p in m.group(1).split(","):
                p = p.strip()
                if not p:
                    continue
                src = re.sub(r"^\s*type\s+", "", p).split(" as ")[0].strip()
                target = m.group(2)
                if target in exported and src not in exported[target]:
                    problems.append(f"{d}/{mod}: imports {{ {src} }} but {target}.ts does not export it")
        for m in re.finditer(r'import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"\./([\w.]+)\.js"', text):
            target = m.group(2)
            if target not in files:
                problems.append(f"{d}/{mod}: imports missing module {target}")

print("problems:", len(problems))
for p in problems:
    print(" -", p)
