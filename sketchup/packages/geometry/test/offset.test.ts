import { describe, expect, it } from "vitest";
import { type Vec2 } from "../src/index.js";
import { offsetRing } from "../src/offset.js";
import { ringIsCcw } from "../src/polygon.js";

/** Signed shoelace area: positive counter-clockwise. */
const signed = (ring: readonly Vec2[]): number => {
  let a2 = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const p = ring[i]!;
    const q = ring[j]!;
    a2 += q[0] * p[1] - p[0] * q[1];
  }
  return a2 / 2;
};

/** Unsigned area: `index.ts`'s polygonArea only handles triangles, and
 * `rings.ts`'s signedArea sums both directions of every edge. */
const area = (ring: readonly Vec2[]): number => Math.abs(signed(ring));

const square = (size: number): Vec2[] => [
  [0, 0],
  [size, 0],
  [size, size],
  [0, size],
];

/** Distance from p to the infinite line through a and b. */
function lineDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  return Math.abs(ex * (p[1] - a[1]) - ey * (p[0] - a[0])) / Math.hypot(ex, ey);
}

function ok(result: ReturnType<typeof offsetRing>): Vec2[] {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.points;
}

describe("offsetRing", () => {
  it("insets a 100 square by 10 into an 80 square, each point 10 from its side", () => {
    const out = ok(offsetRing(square(100), -10));
    expect(area(out)).toBeCloseTo(6400, 6);
    const sides: [Vec2, Vec2][] = [
      [
        [0, 0],
        [100, 0],
      ],
      [
        [100, 0],
        [100, 100],
      ],
      [
        [100, 100],
        [0, 100],
      ],
      [
        [0, 100],
        [0, 0],
      ],
    ];
    for (const p of out) {
      const nearest = Math.min(...sides.map(([a, b]) => lineDistance(p, a, b)));
      expect(nearest).toBeCloseTo(10, 6);
    }
    expect(out).toEqual([
      [10, 10],
      [90, 10],
      [90, 90],
      [10, 90],
    ]);
  });

  it("outsets the same square by 10 into a 120 square", () => {
    const out = ok(offsetRing(square(100), 10));
    expect(area(out)).toBeCloseTo(14400, 6);
    expect(out).toEqual([
      [-10, -10],
      [110, -10],
      [110, 110],
      [-10, 110],
    ]);
  });

  it("changes a 600x400 rectangle's area by the expected amount", () => {
    const rect: Vec2[] = [
      [0, 0],
      [600, 0],
      [600, 400],
      [0, 400],
    ];
    // 600 x 400 = 240000; a 50 inset leaves 500 x 300 = 150000, a loss of 90000.
    const before = area(rect);
    expect(before).toBeCloseTo(240000, 6);
    const out = ok(offsetRing(rect, -50));
    expect(area(out)).toBeCloseTo(150000, 6);
    expect(Math.abs(area(out) - before)).toBeCloseTo(90000, 6);
    expect(out).toEqual([
      [50, 50],
      [550, 50],
      [550, 350],
      [50, 350],
    ]);
  });

  it("insets a triangle so every side sits d inside the matching original edge", () => {
    const tri: Vec2[] = [
      [0, 0],
      [200, 0],
      [60, 150],
    ];
    const out = ok(offsetRing(tri, -5));
    expect(out).toHaveLength(3);
    expect(area(out)).toBeLessThan(area(tri));
    // Each corner is where two inset edges meet, and each inset edge is 5 from
    // the original edge with the same direction.
    for (let i = 0; i < 3; i++) {
      const a = tri[i]!;
      const b = tri[(i + 1) % 3]!;
      expect(lineDistance(out[i]!, a, b)).toBeCloseTo(5, 6);
      expect(lineDistance(out[(i + 1) % 3]!, a, b)).toBeCloseTo(5, 6);
    }
    for (const p of out) {
      for (let i = 0; i < 3; i++) {
        expect(lineDistance(p, tri[i]!, tri[(i + 1) % 3]!)).toBeGreaterThan(4.9);
      }
    }
  });

  it("keeps the winding of a clockwise input ring", () => {
    const cw = [...square(100)].reverse();
    expect(ringIsCcw(cw)).toBe(false);
    const out = ok(offsetRing(cw, -10));
    expect(ringIsCcw(out)).toBe(false);
    expect(signed(out)).toBeLessThan(0);
    expect(area(out)).toBeCloseTo(6400, 6);
  });

  it("refuses an inset deeper than half the square's width", () => {
    const result = offsetRing(square(100), -60);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Collapsed or self-intersect both mean "no such ring"; the ring at 60 has
    // walls that crossed and cut each other, which reads either way.
    expect(["collapsed", "self-intersect"]).toContain(result.reason);
    // Deep but legal: 40 still leaves a 20 x 20 ring, so only 60 is refused.
    expect(area(ok(offsetRing(square(100), -40)))).toBeCloseTo(400, 6);
  });

  it("refuses an inset that is too deep for a 100 x 4 strip", () => {
    const strip: Vec2[] = [
      [0, 0],
      [100, 0],
      [100, 4],
      [0, 4],
    ];
    const result = offsetRing(strip, -3);
    expect(result.ok).toBe(false);
  });

  it("insets an L-shaped hexagon and moves the reflex corner the right way", () => {
    // 100 x 100 square with a 50 x 50 bite out of the top-right, CCW.
    const l: Vec2[] = [
      [0, 0],
      [100, 0],
      [100, 50],
      [50, 50],
      [50, 100],
      [0, 100],
    ];
    expect(area(l)).toBeCloseTo(7500, 6);
    const out = ok(offsetRing(l, -10));
    expect(area(out)).toBeCloseTo(3900, 6);
    // Reflex corner at (50, 50) moves out to (40, 40): the bite grows, the way
    // an inset deepens a notch, while the other corners pull in by 10.
    expect(out).toContainEqual([40, 40]);
    expect(out).toContainEqual([10, 10]);
  });

  it("refuses a needle-sharp apex rather than keeping a 100 mm spike", () => {
    // The interior angle at [0, 200] is about 5.7 degrees, so its miter would
    // run ~100 mm on a 5 mm offset — past the apex's own walls. SketchUp ends
    // such a corner; keeping a needle would be the lie.
    const spike: Vec2[] = [
      [0, 200],
      [10, 0],
      [-10, 0],
    ];
    expect(offsetRing(spike, -5).ok).toBe(false);
  });

  it("outsetting the needle keeps it legal", () => {
    // Growing has nothing to cross, so the same apex is accepted; the outline
    // grows rather than shrinks.
    const spike: Vec2[] = [
      [0, 200],
      [10, 0],
      [-10, 0],
    ];
    const out = ok(offsetRing(spike, 5));
    expect(Math.abs(area(out))).toBeGreaterThan(Math.abs(area(spike)));
  });

  it("returns the ring unchanged for a zero offset", () => {
    const ring = square(100);
    const out = ok(offsetRing(ring, 0));
    expect(out).toEqual(ring);
  });

  it("reports too-short below three points", () => {
    expect(offsetRing([[0, 0], [100, 100]], 10)).toEqual({ ok: false, reason: "too-short" });
    expect(offsetRing([], -10)).toEqual({ ok: false, reason: "too-short" });
  });

  it("cleans a duplicated closing point and still offsets", () => {
    const ring: Vec2[] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
      [0, 0],
    ];
    const out = ok(offsetRing(ring, -10));
    expect(out).toHaveLength(4);
    expect(area(out)).toBeCloseTo(6400, 6);
  });

  it("treats a non-finite distance as no offset", () => {
    const ring = square(100);
    expect(offsetRing(ring, Number.NaN)).toEqual({ ok: true, points: ring });
  });

  it("does not mutate the input ring", () => {
    const cw = [...square(100)].reverse();
    const copy = cw.map((p): Vec2 => [p[0], p[1]]);
    offsetRing(cw, 10);
    expect(cw).toEqual(copy);
  });
});
