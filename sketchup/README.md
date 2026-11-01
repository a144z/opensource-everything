# FitCheck — product 01 of the Apexus portfolio

**The wedge:** every push/pull you make is checked against an envelope you declare,
so you cannot ship something that does not fit.

SketchUp-class direct modelling, MIT-licensed, local-first, offline. Portfolio
index lives one level up in `../MASTER.md`; the REA method that produced this
product is `../../rea/SKILL.md`.

## Status (L0 — skeleton, complete)

Portfolio status lives in `Desktop/opensource-everything/MASTER.md`. This table is the product's
own detail; `docs/05-implementation-plan.md` is the authoritative task list.

| Capability | State |
|---|---|
| Draw a rectangle on the ground plane | ✅ |
| Push/pull a face along its normal | ✅ |
| Fit check against a declared envelope (reports mm overshoot) | ✅ |
| Undo/redo (command pattern, invertible patches) | ✅ |
| Save/open versioned `.fcproj` JSON | ✅ |
| Export STL | ✅ |
| Parallel (orthographic) camera, orbit/pan/zoom extents | ✅ |
| Desktop shell (Tauri 2) | ✅ config + Rust host; `npm run desktop:dev` |
| Manifold WASM booleans | ⏳ L1 (ADR 0002) |
| Inference/snapping, groups, offset, follow-me | ⏳ L1–L2 |

## Run it

```sh
npm install
npm run test        # engine + geometry + invariants (39 tests)
npm run typecheck   # geometry, engine, app (strict TS 7)
npm run dev         # browser at http://localhost:5199  (add ?demo=1 for the demo scene)
npm run desktop:dev # native Tauri window (needs Rust toolchain + icons)
```

## Docs

Full plan in `docs/README.md` — architecture (`04`), task breakdown (`05`),
fit-check spec (`07`), UI spec (`08`), testing (`09`), roadmap (`10`).

- `docs/00-brief.md` — target, user, wedge, non-goals
- `docs/01-current-state.md` — researched market/gap table
- `docs/02-mechanisms.md` — how SketchUp/FreeCAD/Blender/Manifold actually work
- `docs/03-parity-ladder.md` — ordered slices with acceptance tests
- `docs/adr/` — 5 architecture decision records

## Architecture (see `docs/adr`)

```
packages/geometry   pure math, meshes, fit maths  (no DOM)
packages/engine     document, commands, undo, fit check, file format
apps/app            Three.js view + tools + panel (no truth, only derived meshes)
apps/desktop        Tauri 2 host (Rust); window, dialogs, files
```

Rules: `geometry` ← `engine` ← `app` ← `desktop`. Mutations only through
`Command` objects; the renderer caches meshes by `solid.revision`.

## Keys

`R` rectangle · `P` push/pull · `Space` select · `Delete` delete ·
`Ctrl+Z`/`Ctrl+Y` undo/redo · `Z` zoom extents · MMB orbit · RMB pan.

Units are millimetres everywhere, including the file format.

## Licensing note

MIT (see `LICENSE`). No competitor code, assets or trademarks are used. Mechanisms
were studied from public descriptions and docs only; see `docs/02-mechanisms.md`.
