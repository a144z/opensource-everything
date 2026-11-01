import io
import os
import re

SRC = r"C:\Users\justin\Desktop\opensource-everything\sketchup\packages\engine\src"


def module_exports(path):
    """Exported names of one module, following its own `export ... from` lines."""
    text = io.open(path, encoding="utf-8").read()
    direct = set(
        re.findall(
            r"(?m)^export\s+(?:async\s+)?(?:function|const|class|interface|type|let|enum)\s+([A-Za-z0-9_]+)",
            text,
        )
    )
    # export { a, b as c } from "./m.js";   (from-less = local re-export)
    for m in re.finditer(r"(?ms)^export\s*\{([^}]*)\}\s*(?:from\s+\"([^\"]+)\")?", text):
        items = [i.strip() for i in m.group(1).split(",") if i.strip()]
        target = m.group(2)
        if not target:
            direct |= {i.split(" as ")[-1].strip() for i in items}
            continue
        sub = os.path.join(SRC, target.replace("./", "").replace(".js", ".ts"))
        if not os.path.exists(sub):
            continue
        for i in items:
            original = i.split(" as ")[0].strip()
            alias = i.split(" as ")[-1].strip()
            if original == "type":
                continue
            direct.add(alias)
    for m in re.finditer(r"(?ms)^export\s+type\s*\{([^}]*)\}", text):
        direct |= {i.strip().split(" as ")[-1] for i in m.group(1).split(",") if i.strip()}

    # export * from "./m.js" brings in everything the target exports.
    for m in re.finditer(r"(?m)^export\s*\*\s*from\s*\"([^\"]+)\"", text):
        sub = os.path.join(SRC, m.group(1).replace("./", "").replace(".js", ".ts"))
        if os.path.exists(sub):
            direct |= module_exports(sub)
    return direct


index = io.open(os.path.join(SRC, "index.ts"), encoding="utf-8").read()

# Resolve the barrel the way TypeScript sees it, recording repeats.
tally = {}


def add(name, origin):
    tally.setdefault(name, []).append(origin)


for m in re.finditer(r"(?m)^export\s*\*\s*from\s*\"([^\"]+)\"", index):
    sub = os.path.join(SRC, m.group(1).replace("./", "").replace(".js", ".ts"))
    for name in module_exports(sub):
        add(name, m.group(1))

for m in re.finditer(r"(?ms)^export\s*\{([^}]*)\}\s*from\s*\"([^\"]+)\"", index):
    for item in [i.strip() for i in m.group(1).split(",") if i.strip()]:
        add(item.split(" as ")[-1].strip(), m.group(2))

clashes = {k: v for k, v in tally.items() if len(v) > 1}
print("public names:", len(tally))
print("clashes:", clashes or "none")
print("validateRecipe from:", tally.get("validateRecipe"))
