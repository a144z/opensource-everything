# opensource-everything

Free, open-source desktop software that competes with the paid incumbents.

| Product | Replaces | Status |
| --- | --- | --- |
| FitCheck (`sketchup/`) | SketchUp-class massing modelling | Level 1: editable solids, push/pull, fit check |
| Rodsight (`autocad/`) | AutoCAD-class drafting | Planned |

## Layout

```
sketchup/          FitCheck: geometry + kernel + engine + app + Tauri shell
autocad/           placeholder for the drafting product
shared/            code shared across products
```

## FitCheck

Deterministic push/pull modelling where **every edit is checked against a
declared envelope**. Width, height and depth are inputs, not afterthoughts, so
"does it fit in the van / the shelf / the alcove" is answered by the tool
instead of a spreadsheet.

Stack: TypeScript (geometry, engine, app), Rust (Tauri shell), Three.js for the
viewport, `manifold-3d` for booleans.

```powershell
cd sketchup
npm install
npm run dev          # browser
npm run test         # unit tests
npm run build        # production bundle
npm run desktop:build
```

See `sketchup/docs/` for the architecture and decisions.

## Licence

MIT (see `LICENSE`).
