# progress.md - FitCheck

A letter to the next session. Short, factual, newest cycle at the top.
Git wins over anything here that disagrees.

## Cycle 2026-11-01 (line tool)

Done
- L1-5 passes. The Line tool draws a real chain: every click adds a segment,
  clicking back on the start closes the ring into a face, Enter ends an open
  chain, Escape cancels with nothing committed, and the whole chain is one
  object and one undo step.
- Edges are first-class geometry, not a guide slab. New recipe kind `"edge"`
  (`packages/geometry/src/edges.ts`: `EdgePath`, `edgePositions`, `edgesMesh`),
  zero volume and zero area, validated by `assertEdgeRecipe`. The renderer
  reuses the face flat path and the outliner labels it "Edge".
- `SCHEMA_VERSION` 6 -> 7 with a migration entry. A version-6 file has no edges,
  so it upgrades simply by being understood.
- Typed length: digits preview the next point, Enter places it exactly that far
  along the cursor direction (falling back to the last segment, then the red
  axis), and the chain keeps going. A second Enter finishes it.
- Smoke now drives the tool through the live controller (`drawLine`,
  `clickGround`, `chainLength`, `edgePoints`, `lastAdded`, `hint`, `measure`):
  open chain, single undo, close to face with the right area, typing places
  nothing, Enter places exactly 500 mm, Escape leaves nothing.

Decisions
- The finished chain is *one* command, so one Ctrl+Z removes a whole drawn
  loop, as SketchUp does.
- `hover` honours a 3D point when the caller supplies one instead of always
  re-projecting the pixel: a snap has already found the vertex and re-projecting
  threw that away.
- `lastAdded` reads the finish step's selection; "the last row" also answers with
  whatever the model already held.

Open bugs
- none known; the gate is green (13/13 checks, typecheck, 436 tests, smoke).

Next
1. L1-6 - inference wiring + glyphs (endpoint/midpoint snaps, coloured axis
   locks, Shift square, status hint naming the active inference).
2. Then L1-7 offset, L1-8 follow-me, L1-10 dimension, L1-11 tape, L1-9
   sticky/weld, L3-5/6/7, L1-15 soften.

## Cycle 2026-11-01 (first green gate)

Done
- H-01, L1-14 and V-01 now pass. `.\harness.ps1 verify` from cold: 10/10
  checks, typecheck 0 errors, 424/424 tests, smoke clean.
- The smoke step starts its own Vite on :5198 when nothing answers yet, so the
  gate works from a clean checkout. It was failing with
  `null.textContent` only because no server was running.
- Bugs the first real run exposed, all fixed at the source:
  - `faceCentres` and `perpendicularFeet` read `positions` as triangle soup
    while every caller passed an indexed `MeshData`. Both now take the mesh and
    walk `indices`; `Shopper.candidates` passes the mesh.
  - Face centres are area-weighted triangle centroids, not per-triangle means.
  - `pointInPolygon` is a plain half-open even-odd ray again; the nudge that
    was there to dodge vertices moved the crossing and could flip a lobe.
  - `instanceCopy` dropped `definition`, so a copy of a component left its set.
    It now stays in the set (SketchUp behaviour) and `liveCopyRecipe` is the one
    place that decides it.
  - `makeComponent` may promote an instance to the set it is already in, and
    refuses only when the new name would rename every sibling.
  - The definition row's label is always derived from the set name
    (`definitionRowName`), never carried over from the body's old name.
- Tests corrected where the *expectation* was wrong (rotation signs, sixteenth
  ties, bow-tie lobes, rotation-vs-matrix in a scaled transform). No test was
  weakened to pass.

Decisions
- A component's definition body is hidden: one set means one body on screen.
  Validation is run against the instance, not the hidden definition.
- A copy of an instance is an instance of the same set; only "Make Component"
  creates a set.

Open bugs
- none known; the gate is green.

Next
1. L1-5 - line tool (preview, snap to endpoints, close ring to a face, typed
   length, Escape cancels, one undo step for the chain).
2. Then L1-6 inference wiring, L1-7 offset, L1-8 follow-me, L1-10 dimension,
   L1-11 tape, L1-9 sticky/weld, L3-5/6/7, L1-15 soften.

## Cycle 2026-11-01 (build loop introduced)
