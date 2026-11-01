# progress.md - DraftCheck

A letter to the next session. Short, factual, newest cycle at the top.
Git wins over anything here that disagrees.

## Cycle 2026-11-02 (A-01: the app shell)

Done
- `apps/app`: Vite + `<canvas>` shell - `state.ts` (document edit/undo/select),
  `camera.ts` (view transform, grid step, fit), `render.ts` (all 12 entity
  kinds, grips, paper frame), `tools.ts` (`Runner` + every tool, ~1k lines),
  `io.ts` (project/DXF/SVG open+save), `main.ts` (wiring, command table,
  aliases, layer panel, `window.draftcheckTest`).
- `scripts/ui-smoke.mjs`: real Chrome over CDP, 20 checks, one per A-01
  acceptance line. It presses the actual buttons where a button exists.
- `harness.ps1 verify` now runs five steps and is green:
  PASS typecheck, typecheck-app, tests, smoke, ui.
- Engine bugs the UI smoke found and fixed:
  - `parseXY` split `0,0` into three parts (trailing empty), so *no* typed
    coordinate ever parsed. Filter empties.
  - `projectScene` never projected dimension points, so `dimensionRule`'s
    `id|p1:0` keys were always "missing" and every drive failed.
  - `constraintsFromRules` built a distance from one coordinate per point;
    now it uses `x,y,x,y` and `dimensionLinkConstraints` ties each end to the
    vertex it sits on.
  - `driveDimension` is now a plain, stated edit (pivot end holds, the other
    end slides along the measured direction, coincident vertices travel) rather
    than a least-norm solve that swung corners in arbitrary directions.

Notes for the next session
- `Runner.start` accepts a `Tool` or a `ToolFactory`; tools with per-gesture
  state (`line`, `polyline`, `dimlinear`, the edit tools) are factories.
  A new stateful tool must be one, or two gestures will share its state.
- `apps/app/node_modules` is a junction to `sketchup/node_modules` (no install).
- `window.draftcheckTest.command()` is the *command line*: while a tool asks,
  a line is an answer, at idle it is a command.

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
1. A-02 - dimension editing in the UI: click a dimension, type a value,
   `driveDimension` runs, failure keeps the old geometry and says why.
2. A-03 - sheets and plotting from `plotTransform` (SVG now; PDF + a desktop
   export without the download prompt next).
