# progress.md - DraftCheck

A letter to the next session. Short, factual, newest cycle at the top.
Git wins over anything here that disagrees.

## Cycle 2026-11-01 (engine core green)

Done
- `packages/cad/src/cad.ts`: the whole headless engine in one file (~3.8k
  lines): units/expressions, entities, layers, blocks, command + invertible
  patch undo, draw/edit commands, picking and snapping, constraint solver,
  driving dimensions, offset/fillet/trim/extend/join/explode, DXF read/write,
  `.dwgcad` project format, plot transform and SVG.
- 31 tests in `packages/cad/test/cad.test.ts`, all passing.
- `scripts/smoke.mjs`: six beats headless under plain `node` (draw, solve,
  refused dimension, DXF round-trip, project save/load, 1:10 plot).
- `harness.ps1` (check/verify/report/next/tick/untick), gate green:
  PASS typecheck, PASS tests, PASS smoke.
- `feature_list.json` (8 features; H-01, E-01..E-04 pass; A-01..A-03 open).

Bugs found and fixed this cycle (all real, all caught by tests)
- Solver read its `start` snapshot while Newton was probing; residuals now
  read a live view of the working state.
- `solveDocument` returned success when every variable was pinned (no free
  vars, constraints never tested). Now reports "every point is pinned".
- Residual threshold was `tolerance * 100` (1e-7), so any fit not converged to
  machine precision reported failure. Now `SOLVE_RESIDUAL_LIMIT` = 5e-4 mm.
- A constraint naming deleted geometry threw and took down the session; now
  reported in `failed`, the rest of the system still solves.
- `constraintFromPairs` accepted the wrong arity, producing `undefined`
  variables deep in the solver; now validated against `CONSTRAINT_ARITY`.
- `filletLines` returned null for lines sharing an endpoint (the common case),
  picked the corner itself as the "far" end, and had a stray
  `void tangentDist` that crashed at runtime. Rewritten.
- Test fixtures were fitting themselves to engine bugs; they now assert the
  drawing contract (start point pinned, length driven, no NaN, finite output).

Decisions
- One file for the engine until it is feature-complete; split by concern after
  (user's call: write the whole engine in one shot, break down later).
- `varValue` returns 0 for a missing variable instead of throwing: the
  pre-flight check names dangling references, and a torn mid-edit drawing must
  not crash the solve loop.

Open bugs
- (none known; the gate is green)

Next
1. A-01 - the app shell (`apps/app`, Vite + canvas viewport, layer panel,
   command line). Pattern-match `../sketchup/apps/app`.
2. A-02 - dimension editing in the UI, live solve, failure toast.
3. A-03 - sheets and plotting from `plotTransform`.
