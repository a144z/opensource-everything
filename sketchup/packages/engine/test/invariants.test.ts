import { describe, expect, it } from "vitest";
import {
  Session,
  addSolid,
  analyzeSolid,
  checkFit,
  deleteSolids,
  deserializeJson,
  pullFace,
  serializeJson,
  setEnvelope,
  type SolidRecipe,
} from "../src/index.js";

/**
 * Invariants from docs/09-testing.md, cheap enough to run on every save.
 * No mocks and no fixtures: these protect geometry truth and undo honesty.
 */

const box = (
  w: number,
  h: number,
  d: number,
  origin: readonly [number, number, number] = [0, 0, 0],
): SolidRecipe => ({ kind: "box", width: w, height: h, depth: d, origin });

/** xorshift32, so a failure reproduces from its seed. */
function rng(seed: number): () => number {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}

function randomRun(seed: number, n: number): Session {
  const session = new Session({ idPrefix: `p${seed}_` });
  const rand = rng(seed);
  for (let i = 0; i < n; i++) {
    const ids = [...session.document.solids.keys()];
    const roll = ids.length === 0 ? 0 : Math.floor(rand() * 4);
    if (roll === 0) {
      session.execute(
        addSolid(box(1 + Math.floor(rand() * 50), 1 + Math.floor(rand() * 50), 1 + Math.floor(rand() * 9))),
      );
    } else if (roll === 1) {
      const id = ids[Math.floor(rand() * ids.length)]!;
      const prev = session.document.solids.get(id)!.recipe as Extract<SolidRecipe, { kind: "box" }>;
      session.execute(pullFace(id, { ...prev, depth: prev.depth + 1 + Math.floor(rand() * 10) }));
    } else if (roll === 2) {
      session.execute(deleteSolids([ids[Math.floor(rand() * ids.length)]!]));
    } else {
      session.execute(
        setEnvelope(
          rand() < 0.3
            ? null
            : { min: [0, 0, 0], max: [100 + rand() * 500, 100 + rand() * 500, 100 + rand() * 500] },
        ),
      );
    }
  }
  return session;
}

describe("invariant: undo totality", () => {
  for (const seed of [1, 42, 1337, 99991]) {
    it(`seed ${seed}: 60 random ops undo back to the start`, () => {
      const start = new Session().hash();
      const session = randomRun(seed, 60);
      let undone = 0;
      while (session.undo()) undone++;
      expect(undone).toBe(60);
      expect(session.document.solids.size).toBe(0);
      expect(session.document.envelope).toBeNull();
      expect(session.hash()).toBe(start);
    });
  }

  it("redo after a full undo restores the final hash", () => {
    const session = randomRun(7, 20);
    const final = session.hash();
    while (session.undo()) void 0;
    while (session.redo()) void 0;
    expect(session.hash()).toBe(final);
  });

  it("a failing edit can always be undone", () => {
    const s = new Session();
    s.execute(setEnvelope({ min: [0, 0, 0], max: [100, 100, 100] }));
    s.execute(addSolid(box(100, 100, 100)));
    const passing = s.hash();
    const [id] = [...s.document.solids.keys()];
    s.execute(pullFace(id!, box(100, 100, 140)));
    expect(s.fit().pass).toBe(false);
    s.undo();
    expect(s.fit().pass).toBe(true);
    expect(s.hash()).toBe(passing);
  });
});

describe("invariant: determinism", () => {
  it("the same command sequence yields the same hash across sessions", () => {
    const a = new Session({ idPrefix: "d" });
    const b = new Session({ idPrefix: "d" });
    for (const s of [a, b]) {
      s.execute(addSolid(box(10, 20, 30)));
      s.execute(addSolid(box(1, 2, 3)));
    }
    expect(a.hash()).toBe(b.hash());
  });

  it("random runs with the same seed agree", () => {
    expect(randomRun(555, 30).hash()).toBe(randomRun(555, 30).hash());
  });
});

describe("invariant: geometry truth", () => {
  it("every generated solid is closed with positive volume", () => {
    const session = randomRun(31337, 40);
    for (const solid of session.document.solids.values()) {
      const geo = analyzeSolid(solid, (r) => session.resolve(r));
      expect(geo.closed).toBe(true);
      expect(geo.volume).toBeGreaterThan(0);
    }
  });
});

describe("invariant: fit agreement", () => {
  it("never passes when any overshoot exceeds tolerance", () => {
    const rand = rng(5);
    for (let i = 0; i < 200; i++) {
      const s = new Session();
      s.execute(setEnvelope({ min: [0, 0, 0], max: [500, 500, 500] }));
      s.execute(addSolid(box(1 + rand() * 1000, 1 + rand() * 1000, 1 + rand() * 1000)));
      const fit = s.fit();
      const anyOver = fit.overshoot.x > 0.01 || fit.overshoot.y > 0.01 || fit.overshoot.z > 0.01;
      expect(fit.pass).toBe(!anyOver);
      expect(checkFit(s.document).pass).toBe(fit.pass);
    }
  });

  it("sees overshoot on the negative side of the origin", () => {
    const s = new Session();
    s.execute(setEnvelope({ min: [0, 0, 0], max: [10, 10, 10] }));
    s.execute(addSolid(box(10, 10, 10, [-50, 0, 0])));
    const fit = s.fit();
    expect(fit.pass).toBe(false);
    // min corner is 50 mm left of the envelope; max corner is 40 mm short of it.
    expect(fit.worst).toEqual({ axis: "x", mm: 50 });
  });
});

describe("invariant: file fidelity", () => {
  it("serialising a parsed document reproduces the file exactly", () => {
    const session = randomRun(2024, 40);
    const json = serializeJson(session.document);
    expect(serializeJson(deserializeJson(json))).toBe(json);
  });
});

describe("invariant: atomicity", () => {
  it("a throwing command leaves the document untouched", () => {
    const s = new Session();
    s.execute(addSolid(box(10, 10, 10)));
    const before = s.hash();
    expect(() => s.execute(pullFace("nope", box(1, 1, 1)))).toThrow(/unknown solid/);
    expect(s.hash()).toBe(before);
    expect(s.historyLabels.length).toBe(1);
  });
});
