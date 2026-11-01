// Headless smoke: drive the engine the way the app will, without a browser.
// Node 24 strips the types itself, so this runs plain `node`.
//   node scripts/smoke.mjs
// One line per beat; exits non-zero on the first broken beat.
import assert from "node:assert/strict";

const beat = (name) => process.stdout.write(`ok   ${name}\n`);

const C = await import("../packages/cad/src/cad.ts");
const p = C.pt;

// 1. Draw a bracket: a plate with a hole, dimensioned.
const s = new C.CadSession();
assert.equal(s.run(C.addLayer("PLATE", { color: 1 })).ok, true);
s.run(C.setLayer("PLATE"));
assert.equal(s.run(C.addLine(p(0, 0), p(600, 0))).ok, true);
assert.equal(s.run(C.addLine(p(600, 0), p(600, 300))).ok, true);
assert.equal(s.run(C.addLine(p(600, 300), p(0, 300))).ok, true);
assert.equal(s.run(C.addLine(p(0, 300), p(0, 0))).ok, true);
const hole = s.run(C.addCircle(p(300, 150), 60));
assert.equal(hole.ok, true);
beat("draw plate + hole");

// 2. The corner is square by construction; drive a dimension and watch it move.
const ids = [...s.doc.entities.keys()];
const bottom = ids[0];
const l = C.lineVars(bottom, 2);
const solved = C.solveDocument(
  s.doc,
  {
    fixed: [],
    constraints: [...C.pinVars([l.x0, l.y0, l.y1]), C.constraintFromPairs("horizontal", [l.x0, l.y0, l.x1, l.y1])],
  },
  () => "smoke",
);
assert.equal(solved.failed.length, 0);
beat("solve square corner");

// 3. Border: an over-constrained plate must report, not throw.
const impossible = C.solveAnchor(s.doc, {
  fixed: [],
  constraints: [...C.pinVars(C.endpointVars(s.doc.entities.get(bottom)))],
  rules: [{ kind: "distance", dim: "d1", p1: l.x0, p2: l.x1, value: 999 }],
});
assert.ok(impossible.problems.length > 0, "impossible dimension must be reported");
beat("impossible dimension reported");

// 4. DXF out and back: geometry survives and nothing is lost silently.
const dxf = C.writeDxf(s.doc);
assert.ok(dxf.includes("ENTITIES"));
assert.ok(dxf.includes("SECTION"));
const reread = C.readDxf(dxf);
assert.equal(reread.doc.entities.size >= 4, true);
beat(`DXF round-trip (${reread.doc.entities.size} entities, ${reread.skipped.length} skipped)`);

// 5. Project file round-trip at the current schema.
const json = C.serializeProjectJson(s.doc);
const back = C.deserializeProjectText(json);
assert.equal(back.entities.size, s.doc.entities.size);
assert.equal(C.SCHEMA_VERSION, 1);
beat("project save/load");

// 6. Plot a sheet: 600 mm at 1:10 is 60 mm of paper inside an A3 sheet.
const t = C.plotTransform({ scale: 1 / 10, paper: C.PAPER_SIZES.A3, window: { min: p(0, 0), max: p(600, 300) } });
assert.equal(Math.round(C.dist(C.toPaper(t, p(0, 0)), C.toPaper(t, p(600, 0))) * 10) / 10, 60);
const svg = C.plotSvg(s.doc, { scale: 1 / 10, paper: C.PAPER_SIZES.A3, window: { min: p(0, 0), max: p(600, 300) } });
assert.ok(svg.startsWith("<svg"));
beat("SVG plot at 1:10");

process.stdout.write("smoke PASS\n");
