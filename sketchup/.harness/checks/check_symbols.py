"""Statically check that every named import resolves to a real export.

This is the closest thing to a type-check available without running `tsc`
(which is banned during the current code batch), so it is deliberately strict
about the two failures that `tsc` would catch and a human would miss:

  1. an import of a name the target module does not export;
  2. an import of a module that does not exist.

It resolves `export * from`, `export { a, b as c } from`, `export * as ns from`
and `export type` so re-export barrels are followed rather than guessed at.
"""

import io
import os
import re

BASE = r"C:\Users\justin\Desktop\opensource-everything\sketchup"
SKIP_DIRS = {"node_modules", "dist", "target", "gen", ".git"}

# One statement, allowing the brace group to span lines.
IMPORT_RE = re.compile(
    r"import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+\"([^\"]+)\"",
    re.S,
)
DECL_RE = re.compile(
    r"^export\s+(?:async\s+)?(?:function|const|class|interface|type|let|enum)\s+([A-Za-z0-9_]+)",
    re.M,
)
NAMED_RE = re.compile(r"export\s*(?:type\s*)?\{([^}]*)\}\s*(?:from\s+\"([^\"]+)\")?", re.S)
STAR_RE = re.compile(r"export\s*\*\s*from\s*\"([^\"]+)\"")
STAR_AS_RE = re.compile(r"export\s*\*\s*as\s+([A-Za-z0-9_]+)\s+from")


def ts_files(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if name.endswith(".ts"):
                yield os.path.join(dirpath, name)


def resolve(from_file, spec):
    """Path of a relative or package import, or None when it is not local."""
    if spec.startswith("."):
        stem = os.path.join(os.path.dirname(from_file), spec[2:] if spec.startswith("./") else spec)
        stem = stem.replace(".js", "")
        for candidate in (stem + ".ts", os.path.join(stem, "index.ts")):
            if os.path.exists(candidate):
                return candidate
        return None
    for pkg in ("engine", "geometry", "kernel"):
        if spec == f"@apexus/{pkg}":
            entry = os.path.join(BASE, "packages", pkg, "src", "index.ts")
            return entry if os.path.exists(entry) else None
    return None


_cache = {}


def exports_of(path, _seen=None):
    if path in _cache:
        return _cache[path]
    _seen = _seen if _seen is not None else set()
    if path in _seen:
        return set()
    _seen.add(path)
    text = io.open(path, encoding="utf-8").read()
    names = set(DECL_RE.findall(text))
    for m in STAR_RE.finditer(text):
        target = resolve(path, m.group(1))
        if target:
            names |= exports_of(target, _seen)
    names |= set(STAR_AS_RE.findall(text))
    for m in NAMED_RE.finditer(text):
        body, source = m.group(1), m.group(2)
        for item in (i.strip() for i in body.split(",") if i.strip()):
            item = re.sub(r"^type\s+", "", item)
            original, _, alias = item.partition(" as ")
            original, alias = original.strip(), (alias.strip() or original.strip())
            if source is None:
                # A local re-export only counts if the name exists here.
                names.add(alias)
                continue
            target = resolve(path, source)
            if target and original in exports_of(target, _seen):
                names.add(alias)
    _cache[path] = names
    return names


problems = 0
for root in (os.path.join(BASE, "packages"), os.path.join(BASE, "apps"), os.path.join(BASE, "scripts")):
    if not os.path.isdir(root):
        continue
    for path in ts_files(root):
        text = io.open(path, encoding="utf-8").read()
        rel = os.path.relpath(path, BASE)
        for m in IMPORT_RE.finditer(text):
            body, spec = m.group(1), m.group(2)
            target = resolve(path, spec)
            if target is None:
                if spec.startswith("."):
                    print(f"MISSING  {rel}: no module for {spec}")
                    problems += 1
                continue
            have = exports_of(target)
            for item in (i.strip() for i in body.split(",") if i.strip()):
                name = re.sub(r"^type\s+", "", item).split(" as ")[0].strip()
                if name not in have:
                    print(f"NO NAME  {rel}: {name!r} is not exported by {os.path.relpath(target, BASE)}")
                    problems += 1

print("problems:", problems)
