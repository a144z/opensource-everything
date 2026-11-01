import { describe, expect, it } from "vitest";
import { ObjError, objUnitMm, parseObj } from "../src/obj.js";

/**
 * OBJ import (task L4-5). The risk here is silent: OBJ has no unit, so a wrong
 * guess turns a 600 mm chair into a 600 m one without any error. Every refusal and
 * every unit decision is a named case.
 */
const TRIANGLE = ["v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3"].join("\n");
const QUAD = ["v 0 0 0", "v 1 0 0", "v 1 1 0", "v 0 1 0", "f 1 2 3 4"].join("\n");

describe("parseObj", () => {
  it("reads vertices and a triangle", () => {
    const mesh = parseObj(TRIANGLE);
    expect(mesh.positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(mesh.indices).toEqual([0, 1, 2]);
  });

  it("fan-triangulates a quad into two triangles sharing the first corner", () => {
    const mesh = parseObj(QUAD);
    expect(mesh.indices).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it("reads every index spelling: v, v/vt, v//vn, v/vt/vn", () => {
    const text = [
      "v 0 0 0",
      "v 1 0 0",
      "v 0 1 0",
      "vt 0 0",
      "vn 0 0 1",
      "f 1/1 2/2 3/3",
      "f 1//1 2//1 3//1",
      "f 1/1/1 2/2/1 3/3/1",
    ].join("\n");
    expect(parseObj(text).indices).toHaveLength(9);
  });

  it("resolves negative indices against the vertices read so far", () => {
    const text = ["v 0 0 0", "v 1 0 0", "v 0 1 0", "f -3 -2 -1"].join("\n");
    expect(parseObj(text).indices).toEqual([0, 1, 2]);
  });

  it("names the object from o, else g, else usemtl, else Imported", () => {
    expect(parseObj(`o chair\n${TRIANGLE}`).name).toBe("chair");
    expect(parseObj(`g seat\n${TRIANGLE}`).name).toBe("seat");
    expect(parseObj(`usemtl oak\n${TRIANGLE}`).name).toBe("oak");
    expect(parseObj(TRIANGLE).name).toBe("Imported");
  });

  it("keeps the first name when a file has both o and g", () => {
    expect(parseObj(`g seat\no chair\n${TRIANGLE}`).name).toBe("seat");
  });

  it("tolerates CRLF, blank lines, comments and unknown keywords", () => {
    const text = ["# exported", "mtllib x.mtl", "s off", "v 0 0 0", "", "v 1 0 0", "v 0 1 0", "l 1 2", "f 1 2 3", ""].join(
      "\r\n",
    );
    expect(parseObj(text).indices).toEqual([0, 1, 2]);
  });
});

describe("parseObj refusals", () => {
  it("names the line of a bad vertex", () => {
    try {
      parseObj("\nv 0 0\nf 1 2 3");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ObjError);
      expect((err as ObjError).line).toBe(2);
      expect((err as Error).message).toContain("three finite numbers");
    }
  });

  it("names the line of a face with too few corners", () => {
    try {
      parseObj("v 0 0 0\nv 1 0 0\nf 1 2");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ObjError).line).toBe(3);
    }
  });

  it("refuses an out-of-range vertex index, including index 0", () => {
    expect(() => parseObj("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 9")).toThrow(/out of range/);
    expect(() => parseObj("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 0")).toThrow(/not a vertex index/);
  });

  it("refuses a file with no faces, because an outline path needs a closed ring", () => {
    expect(() => parseObj("v 0 0 0\nv 1 0 0")).toThrow(/no faces/i);
  });
});

describe("objUnitMm", () => {
  it("maps the unit names an exporter may write", () => {
    expect(objUnitMm("mm")).toBe(1);
    expect(objUnitMm("cm")).toBe(10);
    expect(objUnitMm("m")).toBe(1000);
    expect(objUnitMm("in")).toBe(25.4);
    expect(objUnitMm("inch")).toBe(25.4);
  });

  it("honours a `# units:` comment and nothing else", () => {
    expect(parseObj(`# units: cm\n${TRIANGLE}`).declaredUnit).toBe("cm");
    expect(parseObj(`# units="in"\n${TRIANGLE}`).declaredUnit).toBe("in");
    expect(parseObj(TRIANGLE).declaredUnit).toBeNull();
  });

  it("returns null so the caller can say it assumed millimetres", () => {
    expect(objUnitMm(null)).toBeNull();
    expect(objUnitMm("fathoms")).toBeNull();
  });
});
