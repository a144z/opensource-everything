import fs from "node:fs";
import path from "node:path";

const roots = ["apps", "packages", "docs", "src-tauri"].map((d) => path.resolve(d)).filter((d) => fs.existsSync(d));
const bad = [];

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "dist-types", "target", ".git"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx|css|html|json|md|rs|toml|js)$/.test(e.name)) bad.push(p);
  }
}

for (const r of roots) walk(r);

const decoder = new TextDecoder("utf-8", { fatal: true });
let fixed = 0;
for (const f of bad) {
  const bytes = fs.readFileSync(f);
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    // Written by Windows PowerShell as ANSI (cp1252); recover then keep only ASCII.
    text = bytes.toString("latin1");
    fixed++;
  }
  if (/[^\x00-\x7F]/.test(text)) {
    text = text
      .replace(/\u00c3\u00a2\u20ac\u201d/g, "--")
      .replace(/\u00c3\u00a2\u20ac\u201c/g, "-")
      .replace(/\u00c2\u00b7/g, "-")
      .replace(/\u00c2\u00b3/g, "3")
      .replace(/\u00c2\u00b2/g, "2")
      .replace(/\u00c2\u00b0/g, "deg")
      .replace(/\u00e2\u20ac\u201d/g, "--")
      .replace(/[^\x00-\x7F]/g, "");
    fixed++;
  }
  fs.writeFileSync(f, text, "utf8");
}
console.log(`scanned ${bad.length}, normalised ${fixed}`);
