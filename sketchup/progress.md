# progress.md - FitCheck

A letter to the next session. Short, factual, newest cycle at the top.
Git wins over anything here that disagrees.

## Cycle 2026-11-01 (inference + glyphs)

Done
- L1-6 passes. Shift locks the pointer to a world axis on every tool that
  constrains, the segment is drawn with SketchUp's red/green/blue guide and a
  square at the inference point, and the status line names the lock
  (`[On red axis]`) instead of the old key help that hid it.
- `axisInference(from, to, tolerance?)` in `packages/geometry/src/inference.ts`:
  only pure code, decides which world axis a post-constraint segment lies on and
  returns its sign and colour. `AXIS_COLOURS` is the single source for red,
  green and blue.
- `View.showAxisGuide({ from, to, colour } | null)` draws the guide line (runs
  on 10 % past the cursor, clamped to 50 mm) and an 8 mm square at the point.
  `View.setAxisLock(on)` lets the tools set the flag the canvas handlers own.
- Shift is now one key with two meanings, as in SketchUp: a rectangle squares
  its corner (`#square`), everything else locks to the dominant axis.
- Tests: 13 for `axisInference`, 4 for screen-tolerance snapping (a corner 12 mm
  off wins at 2 mm/px, gives up past the radius, a midpoint snaps alike), and 4
  browser checks (Shift locks red, the hint names it, the locked segment has no
  lateral drift and is exactly 500 long, an unshifted drag keeps its diagonal).

Decisions
- The guide lives in the view, not the tool: where a coloured line is drawn is a
  presentation choice, and the tool never needs to know its length or styling.
- The line tool's hover now leads its hint with the inference badge. Before, it
  overwrote the badge every frame, so the lock was computed and then hidden.
- `#cancel()` is the one place that drops the guide; a gesture that ends without
  it would leave a coloured line hanging after the click.

Open bugs
- none known; gate green (all checks, typecheck 0 errors, 453/453 tests, smoke).
- Fixed a slow disk leak: every smoke run left its Chrome profile (~30 MB) in
  temp because `chrome.kill()` returned before the handles were released. The
  script now kills the process tree, retries the delete, and leaves nothing. 46
  stale profiles had filled the disk to 0 bytes and broke the first typecheck of
  this cycle.

Next
1. L1-7 - Offset (click a face, drag to inset, typed distance).
2. Then L1-8 follow-me, L1-10 dimension, L1-11 tape, L1-9 sticky/weld,
   L3-5/6/7, L1-15 soften (Ctrl).

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
