import io
import os
import re

root = r"C:\Users\justin\Desktop\opensource-everything\sketchup"
src = os.path.join(root, "apps", "app", "src")
packages = ["packages/geometry/src", "packages/kernel/src", "packages/engine/src"]

problems = []

# 1. Every named import from a relative "./x.js" module must be exported by x.ts.
modules = {}
for name in os.listdir(src):
    if name.endswith(".ts"):
        modules[name[:-3]] = io.open(os.path.join(src, name), encoding="utf-8", newline="").read()


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


for mod, text in modules.items():
    for m in re.finditer(r'import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"\./([\w.]+)\.js"', text):
        wanted = [p.strip() for p in m.group(1).split(",") if p.strip()]
        target = m.group(2)
        if target not in modules:
            problems.append(f"{mod}: imports missing module {target}")
            continue
        have = exports_of(modules[target])
        for w in wanted:
            w = re.sub(r"^\s*type\s+", "", w).split(" as ")[0].strip()
            if w not in have:
                problems.append(f"{mod}: imports {{ {w} }} but {target}.ts does not export it")

# 2. Named imports from @apexus/* must be exported somewhere in that package.
pkg_exports = {}
for p in packages:
    pkg = p.split("/")[1]
    text = []
    for name in os.listdir(os.path.join(root, p)):
        if name.endswith(".ts"):
            text.append(io.open(os.path.join(root, p, name), encoding="utf-8", newline="").read())
    pkg_exports[pkg] = exports_of("\n".join(text))

for mod, text in modules.items():
    for m in re.finditer(r'import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"@apexus/(\w+)"', text):
        pkg = m.group(2)
        have = pkg_exports.get(pkg, set())
        for w in [p.strip() for p in m.group(1).split(",") if p.strip()]:
            w = re.sub(r"^\s*type\s+", "", w).split(" as ")[0].strip()
            if w not in have:
                problems.append(f"{mod}: imports {{ {w} }} from @apexus/{pkg} but it is not exported")

# 3. Function declarations used in main.ts that are declared nowhere in main.ts.
main = modules.get("main", "")
used = set(re.findall(r"(?<![\w.$])([a-z][A-Za-z0-9]*)\(", main))
declared = set(re.findall(r"function\s+([A-Za-z_$][\w$]*)", main))
declared |= set(re.findall(r"(?:const|let)\s+([A-Za-z_$][\w$]*)", main))
declared |= set(re.findall(r"(?:const|let)\s+\{([^}]*)\}", main) and [] or [])
imported = set()
for m in re.finditer(r"import\s+(?:type\s+)?\{([^}]*)\}", main):
    for p in m.group(1).split(","):
        imported.add(re.sub(r"^\s*type\s+", "", p).split(" as ")[-1].strip())
imported.add("function")

words = set(re.findall(r"[A-Za-z_$][\w$]*", main))
for u in sorted(used):
    if u in declared or u in imported or u in words:
        continue
    problems.append(f"main: calls {u}() with no declaration or import")

print("problems:", len(problems))
for p in problems:
    print(" -", p)
