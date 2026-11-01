import { describe, expect, it } from "vitest";
import * as C from "../src/cad.js";

const p = C.pt;

describe("units", () => {
  it("parses suffixes and a bare number", () => {
    expect(C.parseLength("250")?.mm).toBe(250);
    expect(C.parseLength("25cm")?.mm).toBe(250);
    expect(C.parseLength("2.5m")?.mm).toBe(2500);
    expect(C.parseLength("1'")?.mm).toBeCloseTo(304.8);
    expect(C.parseLength('12"')?.mm).toBeCloseTo(304.8);
    expect(C.parseLength("1,5m")?.mm).toBe(1500);
    expect(C.parseLength("abc")).toBeNull();
  });
});

describe("geometry", () => {
  it("signed area and orientation", () => {
    const ring = [p(0, 0), p(100, 0), p(100, 50), p(0, 50)];
    expect(C.signedArea(ring)).toBe(5000);
    expect(C.signedArea(C.ensureCCW([...ring].reverse()))).toBe(5000);
  });
  it("point in polygon", () => {
    const ring = [p(0, 0), p(100, 0), p(100, 50), p(0, 50)];
    expect(C.pointInPolygon(p(50, 25), ring)).toBe(true);
    expect(C.pointInPolygon(p(150, 25), ring)).toBe(false);
  });
  it("arc segments respect tolerance and stay under the cap", () => {
    expect(C.arcSegments(1000, Math.PI * 2)).toBeLessThanOrEqual(C.ARC_MAX_SEGMENTS);
    const pts = C.tessellateArc(p(0, 0), 100, 0, Math.PI / 2);
    expect(pts[0]!.x).toBeCloseTo(100);
    expect(pts[pts.length - 1]!.y).toBeCloseTo(100);
  });
});

function session(): C.CadSession {
  return new C.CadSession(C.emptyDocument("mm"), "t");
}

describe("commands, undo and selection", () => {
  it("draws and undoes in one step", () => {
    const s = session();
    expect(s.run(C.addLine(p(0, 0), p(100, 0))).ok).toBe(true);
    expect(s.run(C.addCircle(p(50, 50), 10)).ok).toBe(true);
    expect(s.doc.entities.size).toBe(2);
    expect(s.undo()).toBe(true);
    expect(s.doc.entities.size).toBe(1);
    expect(s.redo()).toBe(true);
    expect(s.doc.entities.size).toBe(2);
  });
  it("restores the document byte for byte through undo and redo", () => {
    // Every edit in the app is one of these patches, so this is the contract
    // the whole undo stack rests on: apply, invert, get the identical drawing.
    const s = session();
    const snapshots = [JSON.stringify(s.doc)];
    for (const cmd of [
      C.addLine(p(0, 0), p(100, 0)),
      C.addCircle(p(50, 50), 20),
      C.addLayer("WALLS", 0xff0000),
      C.setLayer("1", { locked: true }),
      C.addText(p(10, 10), "PLAN 1:50"),
      C.addPolyline([p(0, 0), p(50, 50), p(100, 0)], false),
    ]) {
      expect(s.run(cmd).ok).toBe(true);
      snapshots.push(JSON.stringify(s.doc));
    }
    for (let i = snapshots.length - 1; i > 0; i--) {
      expect(JSON.stringify(s.doc)).toBe(snapshots[i]);
      expect(s.undo()).toBe(true);
      expect(JSON.stringify(s.doc)).toBe(snapshots[i - 1]);
    }
    for (let i = 1; i < snapshots.length; i++) {
      expect(s.redo()).toBe(true);
      expect(JSON.stringify(s.doc)).toBe(snapshots[i]);
    }
  });
  it("refuses a zero-length line without touching the document", () => {
    const s = session();
    const r = s.run(C.addLine(p(5, 5), p(5, 5)));
    expect(r.ok).toBe(false);
    expect(s.doc.entities.size).toBe(0);
    expect(s.history.depth).toBe(0);
  });
  it("window selection needs full containment, crossing does not", () => {
    const s = session();
    s.run(C.addLine(p(0, 0), p(100, 0)));
    expect(C.selectInRect(s.doc, p(-1, -1), p(50, 1), "window")).toHaveLength(0);
    expect(C.selectInRect(s.doc, p(-1, -1), p(50, 1), "crossing")).toHaveLength(1);
    expect(C.selectInRect(s.doc, p(-1, -1), p(101, 1), "window")).toHaveLength(1);
  });
  it("locks and freezes hide geometry from picking and selection", () => {
    const s = session();
    s.run(C.addLine(p(0, 0), p(100, 0)));
    s.run(C.addLayer("Walls"));
    s.run(C.setLayer("1", { locked: true }));
    const id = [...s.doc.entities.keys()][0]!;
    s.run(C.setEntityStyle([id], { layer: "1" }));
    expect(C.pickEntity(s.doc, p(50, 0), 1)).toBeNull();
    expect(C.selectInRect(s.doc, p(-1, -1), p(101, 1), "window")).toHaveLength(0);
  });
  it("move and rotate keep an arc's angles", () => {
    const s = session();
    s.run(C.addArc(p(0, 0), 10, 0, Math.PI / 2));
    const id = [...s.doc.entities.keys()][0]!;
    s.run(C.rotateEntities([id], p(0, 0), Math.PI / 2));
    const arc = s.doc.entities.get(id) as Extract<C.Entity, { kind: "arc" }>;
    expect(arc.start).toBeCloseTo(Math.PI / 2);
    expect(arc.center.y).toBeCloseTo(0);
  });
  it("deleting a layer moves its entities to layer 0", () => {
    const s = session();
    s.run(C.addLayer("Temp"));
    s.run(C.addLine(p(0, 0), p(10, 0)));
    const id = [...s.doc.entities.keys()][0]!;
    s.run(C.setEntityStyle([id], { layer: "1" }));
    s.run(C.deleteLayer("1"));
    expect(s.doc.entities.get(id)!.layer).toBe("0");
    expect(() => s.run(C.deleteLayer("0"))).toThrow;
  });
});

describe("dimensions", () => {
  it("measures the true distance, not a stored number", () => {
    const s = session();
    s.run(C.addDimension(p(0, 0), p(1000, 0), p(500, 50)));
    const dim = [...s.doc.entities.values()][0] as Extract<C.Entity, { kind: "dimension" }>;
    expect(C.measureDimension(s.doc, dim).value).toBe(1000);
    const g = C.dimensionGeometry(dim);
    expect(g.text).toBe("1000.0");
  });
  it("linear measures the dominant axis, aligned the true length", () => {
    const s = session();
    s.run(C.addDimension(p(0, 0), p(1000, 300), p(500, 500)));
    s.run(C.addDimension(p(0, 0), p(1000, 300), p(500, 500), undefined, { dim: "aligned" }));
    const [a, b] = [...s.doc.entities.values()] as Extract<C.Entity, { kind: "dimension" }>[];
    expect(C.measureDimension(s.doc, a!).value).toBe(1000);
    expect(C.measureDimension(s.doc, b!).value).toBeCloseTo(Math.hypot(1000, 300));
  });
  it("an override text is kept verbatim", () => {
    const s = session();
    s.run(C.addDimension(p(0, 0), p(50, 0), p(25, 20), undefined, { textOverride: "TYP." }));
    const dim = [...s.doc.entities.values()][0] as Extract<C.Entity, { kind: "dimension" }>;
    expect(C.dimensionGeometry(dim).text).toBe("TYP.");
  });
});

describe("expression parser", () => {
  it("respects precedence and parameters", () => {
    const params = new Map([["PANEL", 600]]);
    expect(C.evalExprText("2+3*4", params)).toBe(14);
    expect(C.evalExprText("(2+3)*4", params)).toBe(20);
    expect(C.evalExprText("PANEL*2-PANEL/2", params)).toBe(900);
    expect(C.evalExprText("max(PANEL, 700)", params)).toBe(700);
    expect(C.evalExprText("2^3^2", params)).toBe(512);
    expect(() => C.evalExprText("1/(1-1)", params)).toThrow(C.ExprError);
    expect(() => C.evalExprText("NOPE", params)).toThrow(/unknown parameter/);
  });
});

describe("constraint solver", () => {
  it("makes a line vertical while the other stays horizontal", () => {
    const s = session();
    s.run(C.addLine(p(0, 0), p(100, 0)));
    s.run(C.addLine(p(100, 0), p(110, 40)));
    const [a, b] = [...s.doc.entities.keys()] as [string, string];
    const la = C.lineVars(a, 2);
    const lb = C.lineVars(b, 2);
    expect([...C.projectScene(s.doc).vars.keys()]).toEqual(expect.arrayContaining([lb.y0, lb.y1]));
    expect(C.constraintFromPairs("horizontal", [la.x0, la.y0, la.x1, la.y1]).vars).toEqual([la.x0, la.y0, la.x1, la.y1]);
    expect(C.constraintFromPairs("perpendicularTo", [...Object.values(la), ...Object.values(lb)]).vars).toEqual([...Object.values(la), ...Object.values(lb)]);
    const out = C.solveDocument(
      s.doc,
      {
        fixed: [la.x0, la.y0, la.x1, la.y1],
        constraints: [
          C.constraintFromPairs("horizontal", [la.x0, la.y0, la.x1, la.y1]),
          C.constraintFromPairs("perpendicularTo", [...Object.values(la), ...Object.values(lb)]),
          C.constraintFromPairs("vertical", [lb.x0, lb.y0, lb.x1, lb.y1]),
        ],
      },
      () => "x",
    );
    expect(out.failed).toHaveLength(0);
    const second = out.doc.entities.get(b) as Extract<C.Entity, { kind: "line" }>;
    // b turns upright. Where its pivot lands is up to the solver (least
    // squares favours the midpoint), but both ends must share an x, and line a
    // must not have moved at all.
    expect(second.a.x).toBeCloseTo(second.b.x, 6);
    const first = out.doc.entities.get(a) as Extract<C.Entity, { kind: "line" }>;
    expect(first.a).toEqual(p(0, 0));
    expect(first.b).toEqual(p(100, 0));
    expect(C.dist(second.a, second.b)).toBeGreaterThan(0);
  });
  it("reports an over-constrained system instead of producing NaN", () => {
    // One line, held to two lengths at once: 100 and 180 cannot both hold.
    const s = session();
    s.run(C.addLine(p(0, 0), p(100, 0)));
    const id = [...s.doc.entities.keys()][0]!;
    const l = C.lineVars(id, 2);
    const out = C.solveDocument(
      s.doc,
      {
        fixed: [],
        constraints: [
          ...C.pinVars([l.x0, l.y0]),
          C.constraintFromPairs("horizontal", [l.x0, l.y0, l.x1, l.y1]),
          C.constraintFromPairs("distance", [l.x0, l.y0, l.x1, l.y1], 100),
          C.constraintFromPairs("distance", [l.x0, l.y0, l.x1, l.y1], 180),
        ],
      },
      () => "x",
    );
    expect(out.failed.length).toBeGreaterThan(0);
    expect(out.failed[0]!.message).toMatch(/do not fit/);
    const kept = out.doc.entities.get(id) as Extract<C.Entity, { kind: "line" }>;
    expect(Number.isFinite(kept.a.x) && Number.isFinite(kept.b.x)).toBe(true);
    expect(Number.isFinite(kept.a.y) && Number.isFinite(kept.b.y)).toBe(true);
  });
  it("accepts a fit that lands within a thousandth of a millimetre", () => {
    const s = session();
    s.run(C.addLine(p(0, 0), p(100, 0)));
    const id = [...s.doc.entities.keys()][0]!;
    const l = C.lineVars(id, 2);
    // 0.1 µm of slack: below SOLVE_RESIDUAL_LIMIT, so this is a fit, not a fault.
    const out = C.solveDocument(
      s.doc,
      {
        fixed: [],
        constraints: [...C.pinVars([l.x0, l.y0, l.y1]), C.constraintFromPairs("distance", [l.x0, l.y0, l.x1, l.y1], 100.0001)],
      },
      () => "x",
      { tolerance: 1e-9 },
    );
    expect(C.SOLVE_RESIDUAL_LIMIT).toBeCloseTo(5e-4, 9);
    expect(out.failed).toEqual([]);
    const kept = out.doc.entities.get(id) as Extract<C.Entity, { kind: "line" }>;
    expect(kept.b.x).toBeCloseTo(100.0001, 4);
  });
  it("a typed dimension stretches the rectangle edge it measures", () => {
    const s = session();
    s.run(C.addRectangle(p(0, 0), p(400, 300)));
    s.run(C.addDimension(p(0, 300), p(400, 300), p(200, 400), undefined, { dim: "linear" }));
    const dim = [...s.doc.entities.values()].find((e) => e.kind === "dimension")!;
    const drive = C.driveDimension(s.doc, dim.id, 600);
    expect(drive.problem).toBeNull();
    expect(drive.command).not.toBeNull();
    s.run(drive.command!);
    const rect = [...s.doc.entities.values()].find((e) => e.kind === "polyline")!;
    if (rect.kind !== "polyline") throw new Error("rect");
    expect(Math.max(...rect.points.map((q) => q.x))).toBeCloseTo(600, 6);
    // The pivot edge (x = 0) did not move and nothing else drifted.
    expect(Math.min(...rect.points.map((q) => q.x))).toBeCloseTo(0, 6);
    expect(rect.points.every((q) => q.y === 0 || q.y === 300)).toBe(true);
    expect([...s.doc.entities.values()].find((e) => e.id === dim.id)).toMatchObject({ p2: { x: 600 } });
  });

  it("a dimension on a line grows the line from its first end", () => {
    const s = session();
    s.run(C.addLine(p(10, 20), p(110, 20)));
    s.run(C.addDimension(p(10, 20), p(110, 20), p(60, 50), undefined, { dim: "linear" }));
    const dim = [...s.doc.entities.values()].find((e) => e.kind === "dimension")!;
    s.run(C.driveDimension(s.doc, dim.id, 250).command!);
    const line = [...s.doc.entities.values()].find((e) => e.kind === "line")!;
    if (line.kind !== "line") throw new Error("line");
    expect(line.a).toEqual(p(10, 20));
    expect(line.b.x).toBeCloseTo(260, 6);
    expect(line.b.y).toBeCloseTo(20, 6);
  });

  it("a dimension with nothing under it refuses instead of moving the world", () => {
    const s = session();
    s.run(C.addLine(p(0, 0), p(100, 0)));
    s.run(C.addDimension(p(0, 500), p(100, 500), p(50, 550), undefined, { dim: "linear" }));
    const dim = [...s.doc.entities.values()].find((e) => e.kind === "dimension")!;
    const drive = C.driveDimension(s.doc, dim.id, 300);
    expect(drive.command).toBeNull();
    expect(drive.problem).toBeTruthy();
  });

  it("driving a dimension to zero is refused", () => {
    const s = session();
    s.run(C.addLine(p(0, 0), p(100, 0)));
    s.run(C.addDimension(p(0, 0), p(100, 0), p(50, 30), undefined, { dim: "linear" }));
    const dim = [...s.doc.entities.values()].find((e) => e.kind === "dimension")!;
    expect(C.driveDimension(s.doc, dim.id, 0).command).toBeNull();
  });
});

describe("drawing operations", () => {
  it("offsetRing moves a square outward", () => {
    const ring = [p(0, 0), p(100, 0), p(100, 100), p(0, 100)];
    const out = C.offsetRing(ring, -10, true)!;
    expect(Math.abs(C.signedArea(out))).toBeCloseTo(120 * 120, 6);
  });
  it("fillet produces a tangent arc", () => {
    // Two lines meeting at a right angle corner at the origin, both running away from it.
    const a = { kind: "line", id: "a", a: p(0, 0), b: p(100, 0), layer: "0", color: 256, linetype: "bylayer", lineweight: null } as const;
    const b = { kind: "line", id: "b", a: p(0, 100), b: p(0, 0), layer: "0", color: 256, linetype: "bylayer", lineweight: null } as const;
    const f = C.filletLines(a, b, 20, "a");
    expect(f).not.toBeNull();
    // Tangent points are measured against the lines, not the centre: distance
    // from the centre to a finite segment says nothing about tangency.
    expect(C.closestOnSegment(f!.arc.center, a.a, a.b).distance).toBeCloseTo(20, 6);
    expect(C.closestOnSegment(f!.arc.center, b.a, b.b).distance).toBeCloseTo(20, 6);
    expect(C.dist(f!.lineA, C.pt(20, 0))).toBeCloseTo(0, 6);
    expect(C.dist(f!.lineB, C.pt(0, 20))).toBeCloseTo(0, 6);
    expect(C.dist(f!.arc.center, C.pt(20, 20))).toBeCloseTo(0, 6);
  });
  it("join chains two touching lines", () => {
    const s = session();
    s.run(C.addLine(p(0, 0), p(100, 0)));
    s.run(C.addLine(p(100, 0), p(100, 100)));
    const ids = [...s.doc.entities.keys()];
    const ring = C.joinEntities(s.doc, ids);
    expect(ring).toHaveLength(3);
  });
});

describe("DXF", () => {
  it("round-trips entities and layers", () => {
    const s = session();
    s.run(C.addLayer("Walls", 0xff0000));
    s.run(C.addLine(p(0, 0), p(1000, 0)));
    s.run(C.addCircle(p(500, 500), 250));
    s.run(C.addPolyline([p(0, 0), p(100, 0), p(100, 100)], true));
    s.run(C.addText(p(10, 20), "LIVING ROOM"));
    s.run(C.addDimension(p(0, 0), p(1000, 0), p(500, 100)));
    const dxf = C.writeDxf(s.doc);
    expect(dxf.startsWith("0\r\nSECTION")).toBe(true);
    expect(dxf).toContain("LWPOLYLINE");
    expect(dxf).toContain("AC1032");
    const back = C.readDxf(dxf);
    expect(back.doc.entities.size).toBe(5);
    expect(back.skipped).toHaveLength(0);
    const circle = [...back.doc.entities.values()].find((e) => e.kind === "circle") as Extract<C.Entity, { kind: "circle" }>;
    expect(circle.radius).toBeCloseTo(250);
    const text = [...back.doc.entities.values()].find((e) => e.kind === "text") as Extract<C.Entity, { kind: "text" }>;
    expect(text.value).toBe("LIVING ROOM");
  });
  it("reads a hand-written R12 file and reports what it skips", () => {
    const r12 = [
      "0", "SECTION", "2", "ENTITIES",
      "0", "LINE", "8", "0", "10", "0", "20", "0", "11", "500", "21", "0",
      "0", "ELLIPSE", "8", "0",
      "0", "ENDSEC", "0", "EOF",
    ].join("\n");
    const out = C.readDxf(r12);
    expect(out.doc.entities.size).toBe(1);
    expect(out.skipped).toContain("ELLIPSE");
  });
});

describe("project file", () => {
  it("round-trips through JSON at the current schema", () => {
    const s = session();
    s.run(C.addLine(p(0, 0), p(10, 0)));
    s.run(C.setParam("W", 42));
    const text = C.serializeProjectJson(s.doc);
    const back = C.deserializeProjectText(text);
    expect(back.schemaVersion).toBe(C.SCHEMA_VERSION);
    expect(back.entities.size).toBe(1);
    expect(back.params.get("W")).toBe(42);
  });
  it("refuses a file from a newer build", () => {
    expect(() => C.deserializeProject({ format: "draftcheck", schemaVersion: 99 })).toThrow(/newer/);
  });
});

describe("fit and plot", () => {
  it("snaps the pointer to an endpoint", () => {
    const s = session();
    s.run(C.addLine(p(0, 0), p(1000, 0)));
    const snap = C.fitPointer(s.doc, p(998, 1), { tolerance: 5 });
    expect(snap.kind).toBe("endpoint");
    expect(snap.point.x).toBe(1000);
  });
  it("ortho locks to the dominant axis", () => {
    const snap = C.fitPointer(C.emptyDocument(), p(300, 40), { tolerance: 1, ortho: true, from: p(0, 0) });
    expect(snap.axis).toBe("x");
    expect(snap.point.y).toBe(0);
  });
  it("plots 1000 mm at 1:50 as 20 mm inside an A3 sheet", () => {
    const t = C.plotTransform({ scale: 1 / 50, paper: C.PAPER_SIZES.A3!, window: { min: p(-500, -500), max: p(500, 500) } });
    const a = C.toPaper(t, p(0, 0));
    const b = C.toPaper(t, p(1000, 0));
    expect(C.dist(a, b)).toBeCloseTo(20, 6);
  });
  it("plots SVG with the sheet size", () => {
    const s = session();
    s.run(C.addLine(p(0, 0), p(1000, 0)));
    const svg = C.plotSvg(s.doc, { scale: 1 / 50, paper: C.PAPER_SIZES.A4!, window: { min: p(0, -100), max: p(1000, 100) } });
    expect(svg).toContain('width="297mm"');
  });

  it("honours the nominal scale instead of growing the drawing to fill the sheet", () => {
    // 1000 mm at 1:50 is 20 mm; an almost empty A3 could hold it ten times
    // over, and a plot that did that would print the wrong scale.
    const layout = C.plotLayout({ scale: 1 / 50, paper: C.PAPER_SIZES.A3!, window: { min: p(0, 0), max: p(1000, 600) } });
    const a = C.toPaper(layout, p(0, 0));
    const b = C.toPaper(layout, p(1000, 0));
    expect(C.dist(a, b)).toBeCloseTo(20, 9);
    expect(layout.actual).toBeCloseTo(50, 9);
    expect(layout.fitted).toBe(false);
  });

  it("shrinks to fit an oversized drawing and says so", () => {
    // 100 m wide at 1:50 needs 2 m of paper: fit it, and report a real ratio.
    const layout = C.plotLayout({ scale: 1 / 50, paper: C.PAPER_SIZES.A4!, window: { min: p(0, 0), max: p(100000, 5000) } });
    expect(layout.fitted).toBe(true);
    expect(layout.actual).toBeGreaterThan(50);
    const a = C.toPaper(layout, p(0, 0));
    const b = C.toPaper(layout, p(100000, 0));
    expect(C.dist(a, b)).toBeLessThanOrEqual(C.PAPER_SIZES.A4!.width - 2 * 10 + 1e-6);
  });

  it("prints the chosen scale and sheet size in the title block", () => {
    const s = session();
    s.run(C.addLine(p(0, 0), p(1000, 0)));
    const sheet: C.Sheet = { ...C.DEFAULT_SHEET, paper: "A4", width: 297, height: 210, scale: 50, title: "Bracket" };
    const page = C.plotPage(s.doc, { scale: 1 / 50, paper: C.PAPER_SIZES.A4!, window: { min: p(0, -100), max: p(1000, 100) }, sheet });
    const said = page.texts.map((t) => t.text).join(" | ");
    expect(said).toContain("Bracket");
    expect(said).toContain("A4 297 x 210 mm");
    expect(said).toContain("SCALE 1:50");
  });

  it("draws the same sheet in SVG and PDF", () => {
    const s = session();
    s.run(C.addLine(p(0, 0), p(1000, 0)));
    const opts: C.PlotOptions = { scale: 1 / 50, paper: C.PAPER_SIZES.A4!, window: { min: p(0, -100), max: p(1000, 100) }, sheet: C.DEFAULT_SHEET };
    const svg = C.plotSvg(s.doc, opts);
    const pdf = C.plotPdf(s.doc, opts);
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    // Every stroked segment on paper appears in the SVG as its own <line>.
    const page = C.plotPage(s.doc, opts);
    const svgLines = (svg.match(/<line /g) ?? []).length;
    expect(svgLines).toBe(page.lines.length);
    expect(pdf).toContain(`/MediaBox [0 0 841.8898 595.2756]`);
  });

  it("keeps a sheet through save and reload", () => {
    const s = session();
    const r = s.run(C.setSheet({ title: "Site plan", scale: 100, paper: "A2" }));
    expect(r.ok).toBe(true);
    const back = C.CadSession.load(C.serializeProjectJson(s.doc))!;
    const sheet = C.sheetOf(back.doc);
    expect(sheet.title).toBe("Site plan");
    expect(sheet.scale).toBe(100);
    expect(sheet.paper).toBe("A2");
    expect(sheet.width).toBe(C.PAPER_SIZES.A2!.width);
  });
});

describe("contract", () => {
  it("counts a closed polyline by area and an open one by length", () => {
    const s = session();
    s.run(C.addPolyline([p(0, 0), p(1000, 0), p(1000, 1000), p(0, 1000)], true));
    s.run(C.addLine(p(0, 0), p(500, 0)));
    const rows = C.contractRows(s.doc);
    const area = rows.find((r) => r.kind === "area");
    expect(area?.total).toBe(1_000_000);
    expect(rows.find((r) => r.kind === "length" && r.name === "Line")?.total).toBe(500);
  });
});
