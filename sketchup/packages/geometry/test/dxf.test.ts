import { describe, expect, it } from "vitest";
import { fromDxf } from "../src/io.js";

/**
 * DXF outline import. Only closed polylines become faces: an open polyline is a
 * fence or a wall run, and closing it would invent a face the drawing does not
 * have. These cases exist because the first version ignored the `70` closed flag
 * and closed every polyline silently.
 */
function dxf(...entities: string[]): string {
  return ["0", "SECTION", "2", "ENTITIES", ...entities, "0", "ENDSEC", "0", "EOF"].join("\n");
}

function lwpolyline(closed: boolean, points: readonly (readonly [number, number])[]): string[] {
  const out = ["0", "LWPOLYLINE", "90", String(points.length), "70", closed ? "1" : "0"];
  for (const [x, y] of points) out.push("10", String(x), "20", String(y));
  return out;
}

const SQUARE = [
  [0, 0],
  [100, 0],
  [100, 50],
  [0, 50],
] as const;

describe("fromDxf", () => {
  it("reads a closed LWPOLYLINE as one ring", () => {
    const rings = fromDxf(dxf(...lwpolyline(true, SQUARE)));
    expect(rings).toHaveLength(1);
    expect(rings[0]).toEqual([
      [0, 0],
      [100, 0],
      [100, 50],
      [0, 50],
    ]);
  });

  it("skips an open LWPOLYLINE instead of closing it by a guess", () => {
    expect(fromDxf(dxf(...lwpolyline(false, SQUARE)))).toEqual([]);
  });

  it("keeps a closed ring and drops an open one in the same file", () => {
    const rings = fromDxf(dxf(...lwpolyline(true, SQUARE), ...lwpolyline(false, [[0, 0], [5, 0], [5, 5]])));
    expect(rings).toHaveLength(1);
  });

  it("ignores the closed flag's other bits (spline-fit, 3D polyline)", () => {
    // 70 = 1 (closed) + 8 (3D polyline) + 128 = 137; only bit 1 matters here.
    const lines = lwpolyline(true, SQUARE);
    lines[lines.indexOf("70") + 1] = "137";
    expect(fromDxf(dxf(...lines))).toHaveLength(1);
  });

  it("drops a closed ring with fewer than three points", () => {
    expect(fromDxf(dxf(...lwpolyline(true, [[0, 0], [1, 1]])))).toEqual([]);
  });

  it("reads a POLYLINE/VERTEX/SEQEND run", () => {
    const poly = [
      "0", "POLYLINE", "66", "1", "70", "1",
      "0", "VERTEX", "10", "0", "20", "0",
      "0", "VERTEX", "10", "10", "20", "0",
      "0", "VERTEX", "10", "10", "20", "10",
      "0", "VERTEX", "10", "0", "20", "10",
      "0", "SEQEND",
    ];
    expect(fromDxf(dxf(...poly))).toHaveLength(1);
  });

  it("reads nothing outside the ENTITIES section", () => {
    const text = ["0", "SECTION", "2", "HEADER", ...lwpolyline(true, SQUARE), "0", "ENDSEC", "0", "EOF"].join("\n");
    expect(fromDxf(text)).toEqual([]);
  });
});
