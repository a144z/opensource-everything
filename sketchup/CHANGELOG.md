# Changelog — product 01 (FitCheck, SketchUp-class)

All notable changes. Format: Keep a Changelog, semver.
Portfolio-level status: `Desktop/opensource-everything/MASTER.md`.

## [Unreleased] — L1 core loop + docs

### Added
- Full planning docs: `docs/README.md`, 01, 04, 05, 06, 07, 08, 09, 10, 11 and ADR 0005
- `apps/app/src/changes.ts` + `state.ts`: change bus and UI state (task X-1)
- `View.syncPatches` (per-solid reconcile) and `View.markFailures` (red flag for
  geometry that breaks the fit envelope)
- `packages/engine/test/invariants.test.ts`: undo totality over 4 seeds, determinism,
  geometry truth, fit agreement, file fidelity, command atomicity

## [0.0.1] — 2026-11-01 — L0 skeleton

### Added
- Monorepo: `packages/geometry`, `packages/engine`, `apps/app`, `apps/desktop`
- Pure geometry: box, rectangle extrusion, volume, watertight check, AABB,
  fit maths, ASCII STL export, FNV mesh hash
- Engine: immutable document, invertible command patches, undo/redo, rename,
  delete, envelope commands, derived analysis cache
- Fit check: per-axis overshoot in mm, worst offender, empty/envelope states
- `.fcproj` versioned JSON format with migration chain and validation
- Three.js viewport: orthographic camera, orbit/pan, zoom extents, selection,
  picking, frustum culling, gizmo
- Tools: rectangle (chains into push/pull), push/pull along face normal, select
- Panel: tools, fit check, outliner, save/open/export, undo/redo
- Tauri 2 desktop host configuration
- Tests: 26 passing (geometry + engine, incl. 100-op undo property test)
