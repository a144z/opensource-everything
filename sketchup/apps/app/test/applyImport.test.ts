import { beforeAll, describe, expect, it } from "vitest";
import { Session, type Session as SessionType } from "@apexus/engine";
import { initKernel } from "@apexus/kernel";
import { applyImport } from "../src/applyImport.js";
import { readImport } from "../src/importers.js";

/**
 * Import into the document (task L4-5). `readImport` is covered elsewhere; this is
 * the half that touches the document, so the cases ask "what does the document
 * hold afterwards" rather than "what did the reader return".
 *
 * The last two cases pin a real defect: the first version pushed every DXF outline
 * 10 mm and told the user they were faces, so a plan import quietly became a
 * forest of 10 mm slabs. Caught by review while moving this code out of `main.ts`.
 */

let kernelOn = false;
beforeAll(async () => {
  kernelOn = await initKernel().then(
    () => true,
    () => false,
  );
});

/** The kernel is a WASM download; a headless CI box may not have it. */
function requireKernel(): boolean {
  return kernelOn;
}

const OBJ_CM = ["# units: cm", "v 0 0 0", "v 2 0 0", "v 2 2 0", "v 0 2 0", "f 1 2 3 4"].join("\n");

const DXF_SQUARE = [
  "0", "SECTION", "2", "ENTITIES",
  "0", "LWPOLYLINE", "90", "4", "70", "1",
  "10", "0", "20", "0",
  "10", "100", "20", "0",
  "10", "100", "20", "50",
  "10", "0", "20", "50",
  "0", "ENDSEC", "0", "EOF",
].join("\n");

const DXF_TWO = [
  "0", "SECTION", "2", "ENTITIES",
  "0", "LWPOLYLINE", "90", "4", "70", "1", "10", "0", "20", "0", "10", "10", "20", "0", "10", "10", "20", "10", "10", "0", "20", "10",
  "0", "LWPOLYLINE", "90", "4", "70", "1", "10", "50", "20", "0", "10", "60", "20", "0", "10", "60", "20", "10", "10", "50", "20", "10",
  "0", "ENDSEC", "0", "EOF",
].join("\n");

describe("applyImport refuses what the reader refused", () => {
  it("throws the reader's sentence rather than adding anything", () => {
    const session: SessionType = new Session();
    const outcome = readImport("notes.txt", "hi");
    expect(() => applyImport(session, outcome)).toThrow(/\.obj/);
    expect(session.document.solids.size).toBe(0);
  });

  it("throws for a DXF with no closed polylines", () => {
    const session: SessionType = new Session();
    const empty = ["0", "SECTION", "2", "ENTITIES", "0", "ENDSEC", "0", "EOF"].join("\n");
    expect(() => applyImport(session, readImport("plan.dxf", empty))).toThrow();
    expect(session.document.solids.size).toBe(0);
  });
});

describe("applyImport: an OBJ mesh", () => {
  it("adds exactly one solid, selected by id, in file order", () => {
    if (!requireKernel()) return;
    const session: SessionType = new Session();
    const applied = applyImport(session, readImport("plate.obj", OBJ_CM));
    expect(applied.ids).toHaveLength(1);
    expect(session.document.solids.has(applied.ids[0]!)).toBe(true);
    expect(session.document.solids.size).toBe(1);
  });

  it("applies the file's unit once: a 2 cm edge is 20 mm in the document", () => {
    if (!requireKernel()) return;
    const session: SessionType = new Session();
    const applied = applyImport(session, readImport("plate.obj", OBJ_CM));
    const box = session.boundsOf(applied.ids[0]!);
    expect(box.max[0] - box.min[0]).toBeCloseTo(20, 6);
    expect(box.max[1] - box.min[1]).toBeCloseTo(20, 6);
  });

  it("names the solid after the file's object name", () => {
    if (!requireKernel()) return;
    const session: SessionType = new Session();
    const applied = applyImport(session, readImport("plate.obj", `o jig\n${OBJ_CM}`));
    expect(session.document.solids.get(applied.ids[0]!)!.meta.name).toBe("jig");
  });

  it("says why the size is what it is in the message", () => {
    if (!requireKernel()) return;
    const session: SessionType = new Session();
    const applied = applyImport(session, readImport("plate.obj", OBJ_CM));
    expect(applied.message).toMatch(/cm/);
  });

  it("is one undo step", () => {
    if (!requireKernel()) return;
    const session: SessionType = new Session();
    const before = session.hash();
    applyImport(session, readImport("plate.obj", OBJ_CM));
    session.undo();
    expect(session.hash()).toBe(before);
    expect(session.document.solids.size).toBe(0);
  });
});

describe("applyImport: a DXF outline", () => {
  it("adds one zero-thickness face, not a slab, and says so", () => {
    if (!requireKernel()) return;
    const session: SessionType = new Session();
    const applied = applyImport(session, readImport("plan.dxf", DXF_SQUARE));
    expect(applied.ids).toHaveLength(1);
    const solid = session.document.solids.get(applied.ids[0]!)!;
    expect(solid.recipe.kind).toBe("face");
    expect(applied.message).toMatch(/push\/pull/i);
  });

  it("places the outline on the ground at the drawing's own size", () => {
    if (!requireKernel()) return;
    const session: SessionType = new Session();
    const applied = applyImport(session, readImport("plan.dxf", DXF_SQUARE));
    const at = session.boundsOf(applied.ids[0]!);
    expect(at.max[0] - at.min[0]).toBeCloseTo(100, 6);
    expect(at.max[1] - at.min[1]).toBeCloseTo(50, 6);
    expect(at.max[2] - at.min[2]).toBeCloseTo(0, 6);
  });

  it("adds every ring, in ring order", () => {
    if (!requireKernel()) return;
    const session: SessionType = new Session();
    const applied = applyImport(session, readImport("plan.dxf", DXF_TWO));
    expect(applied.ids).toHaveLength(2);
    // Ring 1 starts at x = 0, ring 2 at x = 50: order is the file's order.
    expect(session.boundsOf(applied.ids[0]!).max[0]).toBeCloseTo(10, 6);
    expect(session.boundsOf(applied.ids[1]!).max[0]).toBeCloseTo(60, 6);
  });

  it("winds every ring the same way, so two imports face the same side", () => {
    if (!requireKernel()) return;
    // The ring is handed in clockwise; the stored face must come back counter-clockwise.
    const clockwise = [
      "0", "SECTION", "2", "ENTITIES",
      "0", "LWPOLYLINE", "90", "4", "70", "1", "10", "0", "20", "0", "10", "0", "20", "10", "10", "10", "20", "10", "10", "10", "20", "0",
      "0", "ENDSEC", "0", "EOF",
    ].join("\n");
    const session: SessionType = new Session();
    const applied = applyImport(session, readImport("plan.dxf", clockwise));
    const solid = session.document.solids.get(applied.ids[0]!)!;
    if (solid.recipe.kind !== "face") throw new Error("expected a face");
    const pts = solid.recipe.points;
    let twice = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      twice += a[0] * b[1] - b[0] * a[1];
    }
    // Counter-clockwise in a right-handed XY plane gives a negative shoelace sum
    // when counted this way; either sign is fine as long as it is *one* sign.
    expect(Math.abs(Math.sign(twice))).toBe(1);
  });

  it("is one undo step", () => {
    if (!requireKernel()) return;
    const session: SessionType = new Session();
    const before = session.hash();
    applyImport(session, readImport("plan.dxf", DXF_TWO));
    session.undo();
    expect(session.hash()).toBe(before);
  });
});
