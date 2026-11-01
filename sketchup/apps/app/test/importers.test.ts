import { describe, expect, it } from "vitest";
import { formatOf, readImport } from "../src/importers.js";

/**
 * The import router (task L4-5). It must never throw: every failure is a value
 * with a sentence the panel can show. The DXF path is checked because a DXF that
 * silently imports nothing looks identical to a DXF that failed.
 */
const STL = ["facet normal 0 0 1", "  outer loop", "    vertex 0 0 0", "    vertex 10 0 0", "    vertex 0 10 0",
  "  endloop", "endfacet", "endsolid"].join("\n");

const OBJ = ["v 0 0 0", "v 2 0 0", "v 0 2 0", "f 1 2 3"].join("\n");

const DXF = [
  "0", "SECTION", "2", "ENTITIES",
  "0", "LWPOLYLINE", "90", "4", "70", "1",
  "10", "0", "20", "0",
  "10", "100", "20", "0",
  "10", "100", "20", "50",
  "10", "0", "20", "50",
  "0", "ENDSEC", "0", "EOF",
].join("\n");

describe("formatOf", () => {
  it("routes by extension, case-insensitively and through whitespace", () => {
    expect(formatOf("a.STL")).toBe("stl");
    expect(formatOf("a.obj ")).toBe("obj");
    expect(formatOf("a.DaE")).toBe("dae");
    expect(formatOf("a.dxf")).toBe("dxf");
    expect(formatOf("desk.fcproj")).toBe("project");
    expect(formatOf("desk.json")).toBe("project");
  });

  it("returns null for a file it cannot read", () => {
    expect(formatOf("notes.txt")).toBeNull();
    expect(formatOf("")).toBeNull();
  });
});

describe("readImport routing", () => {
  it("refuses an unknown extension with the list of what works", () => {
    const out = readImport("notes.txt", "hello");
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.reason).toContain(".obj");
  });

  it("reads an STL as one mesh in millimetres", () => {
    const out = readImport("part.stl", STL);
    expect(out.kind).toBe("mesh");
    if (out.kind === "mesh") {
      expect(out.recipe.kind).toBe("mesh");
      expect(out.note).toMatch(/millimetres/i);
    }
  });

  it("scales an OBJ that declares centimetres and says so", () => {
    const out = readImport("chair.obj", `# units: cm\n${OBJ}`);
    expect(out.kind).toBe("mesh");
    if (out.kind === "mesh") {
      expect(out.note).toMatch(/cm/);
      // A 2 cm edge is 20 mm; the mesh recipe stores it already in millimetres.
      const positions = out.recipe.kind === "mesh" ? out.recipe.positions : [];
      expect(Math.max(...positions)).toBeCloseTo(20, 6);
    }
  });

  it("says it assumed millimetres for an OBJ with no unit", () => {
    const out = readImport("chair.obj", OBJ);
    expect(out.kind).toBe("mesh");
    if (out.kind === "mesh") expect(out.note).toMatch(/no unit/i);
  });

  it("reads a closed DXF polyline as one outline loop", () => {
    const out = readImport("plan.dxf", DXF);
    expect(out.kind).toBe("outline");
    if (out.kind === "outline") {
      expect(out.loops.length).toBeGreaterThan(0);
      expect(out.loops[0]!.length).toBe(4);
    }
  });

  it("says a DXF has no polylines instead of importing nothing quietly", () => {
    const out = readImport("empty.dxf", ["0", "SECTION", "2", "ENTITIES", "0", "ENDSEC", "0", "EOF"].join("\n"));
    expect(out.kind).toBe("error");
  });

  it("tells the user to Open a project file rather than Import it", () => {
    const out = readImport("desk.fcproj", "{}");
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.reason).toMatch(/Open/);
  });

  it("never throws on garbage input for any supported extension", () => {
    for (const name of ["a.stl", "a.obj", "a.dxf", "a.dae"]) {
      expect(() => readImport(name, "\u0000 not a file \u0000")).not.toThrow();
    }
  });
});
