# 13  Test plan: units, measurements, import, autosave, scale

Written before any of it ran. Every case below names the *behaviour*, the *input*,
and the *observation* that decides pass/fail, so a failure report is a sentence
("case U-4 read `1 0"` not `1' 0"`") rather than "the units test failed".

Status vocabulary (same as L0/L1/L2 in `05-implementation-plan.md`):

- **L1** pure function, covered by `vitest run` in node.
- **L2** needs a browser (canvas, `DOMParser`, `localStorage`, drag). Covered by
  `scripts/smoke.mjs` or by hand until it is in the smoke script.
- **L3** manual judgement (does it *read* right to a person).

Run: `npm test` (all vitest projects). Filter: `npx vitest run apps/app`.

---

## U — Display units (`apps/app/test/display.test.ts`)

| # | Level | Case | Input | Pass |
|---|---|---|---|---|
| U-1 | L1 | Whole feet and inches read like a tape | `304.8` mm | `1' 0"` |
| U-2 | L1 | Feet plus inches | `406.4` mm | `1' 4"` |
| U-3 | L1 | Zero | `0` | `0"` |
| U-4 | L1 | Sixteenths reduce to the smallest fraction | `12.7` | `1/2"` |
| U-5 | L1 | Mixed number | `38.1` | `1 1/2"` |
| U-6 | L1 | Eighth and sixteenth | `9.525`, `1.5875` | `3/8"`, `1/16"` |
| U-7 | L1 | Rounds to the nearest sixteenth, both ways | `25.4+0.79`, `25.4+2.38` | `1"`, `1 1/16"` |
| U-8 | L1 | Sign sits outside the feet | `-304.8` | `-1' 0"` |
| U-9 | L1 | Non-finite never prints NaN | `NaN`, `Infinity` | `""` |
| U-10 | L1 | Each unit keeps its own precision | `12` mm / `12` mm in cm | `12.0mm`, `1.20cm` — not both `12.00` |
| U-11 | L1 | Inches route to architectural form | `formatLengthIn("in", 304.8)` | `1' 0"` |
| U-12 | L1 | Sizes join with `×` and state the unit once | `[600,400,300]` mm | contains 600, 400, 300 and one `mm` |
| U-13 | L1 | Inch sizes repeat the mark on each axis | `[609.6, 304.8]` | `2' 0" × 1' 0"` |
| U-14 | L1 | A bare number reads in the display unit | `parseIn("cm","60")` | `600` |
| U-15 | L1 | An explicit suffix wins over the display unit | `parseIn("in","25mm")` | `25` |
| U-16 | L1 | A foot mark is inches | `parseIn("mm","2'")` | `609.6` |
| U-17 | L1 | Text that is not a length | `"wide"`, `""` | `null` |
| U-18 | L1 | Every offered unit formats | all of `UNIT_IDS` | non-empty |
| U-19 | L1 | Only offered ids are recognised | `"mm"`, `"furlong"` | `true`, `false` |
| U-20 | L2 | The select is built from `UNIT_MENU`, not the HTML | open the app | four options, mm selected |
| U-21 | L2 | The unit survives a reload | pick Inches, F5 | still Inches |
| U-22 | L2 | Changing the unit changes the rail immediately | draw, switch to m | rail re-reads in metres without moving the mouse |
| U-23 | L2 | The unit is not document state | switch unit, Ctrl+Z | the undo stack is untouched; `.fcproj` has no unit |
| U-24 | L3 | A length typed while in inches is read in inches | type `600` in Inches | 600 in = 15240 mm, not 600 mm |

## M — Live measurements (`apps/app/test/measure.test.ts`)

| # | Level | Case | Input | Pass |
|---|---|---|---|---|
| M-1 | L1 | The rail reads value, then label, then prompt | `lengthValue("Length",600,"mm","click")` | starts `600`, contains `Length` and `click` |
| M-2 | L1 | No stray separators when a part is empty | `NO_MEASURE` | `""` |
| M-3 | L1 | Nothing claims to be committed by accident | default phase | `"proposed"` |
| M-4 | L1 | Each phase survives construction | `"committed"`, `"typed"` | unchanged |
| M-5 | L1 | Formatting follows the unit handed in | `600` mm/cm, `304.8` in | `600…`, `60…`, `1' 0"` |
| M-6 | L1 | Angle counts CCW from +X, 0..360 | four axes | `0, 90, 180, 270` |
| M-7 | L1 | Zero-length move is 0, not NaN | same point twice | `0` |
| M-8 | L1 | Angle drops a trailing `.0`, keeps one decimal | `90`, `45.04`, `45.06` | `90°`, `45°`, `45.1°` |
| M-9 | L1 | Rectangle edges are positive from either direction | 4 drags | same `[600,400]` |
| M-10 | L1 | Rectangle edges round to 0.01 mm | `1.23456` | `1.23` |
| M-11 | L1 | Two numbers set both edges, in four spellings | `600,400` `600x400` `600;400` `600 400` | `[600,400]` |
| M-12 | L1 | One number is refused, not guessed | `600` | `null` |
| M-13 | L1 | Three numbers, zero, negative, empty are refused | each | `null` |
| M-14 | L2 | The rail tracks the cursor for rectangle | drag on the ground | both edges update every move |
| M-15 | L2 | Shift squares from the larger edge | drag 600×400 holding Shift | `600 × 600`, `#square` reading |
| M-16 | L2 | Shift pressed without moving squares at once | press Shift mid-drag | reading becomes square before the mouse moves |
| M-17 | L2 | Releasing Shift un-squares | release Shift | next move is free again |
| M-18 | L2 | A typed size wins over the cursor | type `600,400` | rail shows typed value, cursor cannot overwrite it |
| M-19 | L2 | Enter on a typed size builds that face | `600,400`, Enter | one face, 600×400, pushed to push/pull |
| M-20 | L2 | A proposal never looks like a commit | drag, then release | phase differs between the two states in CSS |
| M-21 | L2 | Switching tools clears the rail | R, move, L | rail empty after the tool changes |
| M-22 | L2 | Escape clears the rail | mid-drag Esc | rail hidden, hint still readable |
| M-23 | L2 | Line, circle, polygon, arc, move, rotate, offset, tape, dimension, push/pull all publish a reading | one drag each | rail non-empty for each |
| M-24 | L2 | The rail never flickers back to the last message between moves | move slowly | only the number changes |
| M-25 | L3 | The number is readable over a bright model | white model, rail visible | still legible (own plate, tabular figures) |

## I — Import (`apps/app/test/obj.test.ts`, `importers.test.ts`, `packages/geometry/test/dxf.test.ts`)

| # | Level | Case | Input | Pass |
|---|---|---|---|---|
| I-1 | L1 | Extension routing is case- and whitespace-insensitive | `a.STL`, `a.obj ` | `stl`, `obj` |
| I-2 | L1 | Unknown extension is refused with the list of what works | `notes.txt` | error naming `.obj` |
| I-3 | L1 | OBJ vertices and one triangle | `v…f 1 2 3` | 9 floats, `[0,1,2]` |
| I-4 | L1 | Quad fans into two triangles sharing the first corner | `f 1 2 3 4` | `[0,1,2, 0,2,3]` |
| I-5 | L1 | Every index spelling | `v/vt`, `v//vn`, `v/vt/vn` | 9 indices |
| I-6 | L1 | Negative indices are relative | `f -3 -2 -1` | `[0,1,2]` |
| I-7 | L1 | Name from `o`, else `g`, else `usemtl`, else `Imported` | four files | each name |
| I-8 | L1 | `o` and `g` together keep the first | `g` then `o` | `g`'s name |
| I-9 | L1 | CRLF, blank lines, comments, unknown keywords tolerated | mixed | one triangle |
| I-10 | L1 | A bad vertex names its line | `\nv 0 0` | `line 2` |
| I-11 | L1 | A short face names its line | `f 1 2` on line 3 | `line 3` |
| I-12 | L1 | Out-of-range and zero indices refused | `f 1 2 9`, `f 1 2 0` | two distinct messages |
| I-13 | L1 | No faces is a refusal, not an empty mesh | vertices only | `/no faces/` |
| I-14 | L1 | Unit names map to millimetres | mm, cm, m, in, inch | 1, 10, 1000, 25.4, 25.4 |
| I-15 | L1 | `# units:` comment honoured, nothing else | comment, `units="in"`, none | cm, in, `null` |
| I-16 | L1 | An unknown unit is `null` so the caller can say it assumed mm | `fathoms` | `null` |
| I-17 | L1 | OBJ declaring cm is scaled and says so | `# units: cm`, 2 cm edge | max coordinate 20, note contains `cm` |
| I-18 | L1 | OBJ with no unit says it assumed millimetres | plain OBJ | note `/no unit/i` |
| I-19 | L1 | STL imports as one mesh in millimetres | one facet | recipe `mesh`, note `/millimetres/i` |
| I-20 | L1 | A closed DXF polyline becomes one 4-point loop | square | one loop, 4 points |
| I-21 | L1 | An **open** DXF polyline is skipped, never closed by a guess | `70` = 0 | `[]`; import says "no closed polylines" |
| I-22 | L1 | Closed kept, open dropped in one file | both | one ring |
| I-23 | L1 | Closed flag's other bits ignored | `70` = 137 | one ring |
| I-24 | L1 | A closed ring under three points is dropped | two points | `[]` |
| I-25 | L1 | `POLYLINE`/`VERTEX`/`SEQEND` run | classic polyline | one ring |
| I-26 | L1 | Nothing outside `ENTITIES` is read | square in HEADER | `[]` |
| I-27 | L1 | An empty DXF is an error, not a silent no-op | no polylines | error |
| I-28 | L1 | A project file is routed to Open, not Import | `desk.fcproj` | error mentions Open |
| I-29 | L1 | Garbage never throws for any supported extension | `\0` text | no throw |
| I-30 | L2 | DAE (COLLADA) imports as one solid | a SketchUp-exported `.dae` | one mesh, Z-up, correct size |
| I-31 | L2 | DAE Y-up becomes Z-up without inverting faces | asymmetric model | upright, no dark inside-out faces |
| I-32 | L2 | DAE `<polygons>` is refused by name | n-gon export | refusal naming `<polygons>` |
| I-33 | L2 | DAE `<unit meter="0.01">` scales to mm | cm file | 100× the file numbers |
| I-34 | L2 | Drag-and-drop on the viewport imports, not navigates away | drop `chair.obj` | imported; browser did not open the file |
| I-35 | L2 | The same file can be chosen twice in a row | import, import again | second import runs |
| I-36 | L2 | An imported mesh lands at the file's own origin and is framed | import | placed, view zooms to it |
| I-37 | L3 | An imported OBJ with no unit is a sensible size | typical chair OBJ | chair-sized, and the note says why |

> I-21..I-26 pin a real defect found while writing this plan: `fromDxf` ignored
> the `70` closed flag, so **every** polyline was silently closed into a face.
> The fix reads the flag. Caught by review while writing the test, not by a
> test that already existed — there was none for DXF.

## D — Autosave and recovery (`apps/app/test/draft.test.ts`)

| # | Level | Case | Input | Pass |
|---|---|---|---|---|
| D-1 | L1 | A draft round-trips | write then read | identical |
| D-2 | L1 | An empty slot is `null` | fresh store | `null` |
| D-3 | L1 | Malformed drafts are dropped, not fatal | 6 kinds of junk | `null` each |
| D-4 | L1 | A missing time or name is repaired | `{"json":"{}"}` | `at:0`, `fileName:null` |
| D-5 | L1 | Clear empties the slot | write, clear | `null` |
| D-6 | L1 | A storage failure is swallowed | store that throws | no throw, `false`, `null` |
| D-7 | L1 | No draft, nothing to offer | `null` | `false` |
| D-8 | L1 | A fresh, different draft is offered | now−1 s | `true` |
| D-9 | L1 | A draft equal to the saved file is not offered | same json | `false` |
| D-10 | L1 | A week-old draft is not offered; six days is | boundary | `false`, `true` |
| D-11 | L1 | With no saved file, a draft is still offered | `null` saved | `true` |
| D-12 | L1 | The prompt names the file and the time | `desk.fcproj`, 14:05 | `Recover "desk.fcproj" from 14:05` |
| D-13 | L1 | An unnamed file reads as unsaved work | `null` | `Recover unsaved work from 09:30` |
| D-14 | L1 | First tick writes, identical ticks do not | 4 s idle | 1 write |
| D-15 | L1 | A change writes once | change at 2 s | writes at 1 s and 3 s only |
| D-16 | L1 | Saving suppresses the next write | `markSaved` then tick | no write |
| D-17 | L1 | Paused writes nothing | `pause`, tick | 0 writes |
| D-18 | L1 | No snapshot, no write | snapshot `null` | `false` |
| D-19 | L1 | `start` is idempotent; `stop` is safe twice | call twice | one write, no crash |
| D-20 | L2 | A real draft appears after 30 s | edit, wait 31 s | badge shows a time |
| D-21 | L2 | An idle tab writes nothing | leave it | badge time does not advance |
| D-22 | L2 | Reloading after a crash offers the draft | edit, reload | prompt names the draft |
| D-23 | L2 | Cancel discards it | Cancel | prompt never returns |
| D-24 | L2 | Saving clears the slot | Save, reload | no prompt |
| D-25 | L2 | A corrupt draft is discarded with a message | break localStorage | app opens, message shown |
| D-26 | L2 | Recovery is one undo away from being wrong | recover, Ctrl+Z | back to the pre-recovery document |
| D-27 | L3 | The badge is discoverable but never an alarm | normal use | dim, never flashes |

## S — Scale gizmo commit (`packages/engine/test/transforms.test.ts`)

| # | Level | Case | Input | Pass |
|---|---|---|---|---|
| S-1 | L1 | Scaling about the centre must not move the object | origin 100, ×2 about centre | origin stays 100 |
| S-2 | L1 | One axis at a time | ×1.5 on X only | X 1.5, Y/Z 1, origin unchanged |
| S-3 | L1 | Base rotation kept, not re-read from the gizmo | 30° + garbage | rotation exact, origin unchanged |
| S-4 | L1 | A collapse is refused per axis | 0, NaN | base factor kept, all finite |
| S-5 | L1 | An identity drag changes nothing | identity | identical matrix |
| S-6 | L2 | Dragging a scale handle leaves the object in place | drag X handle | object's min face stays put, grows on the other side |
| S-7 | L2 | The gizmo detaches before commit (no double transform) | drag then release | object moves once, not twice |
| S-8 | L2 | One drag is one undo step | scale, Ctrl+Z | exact previous bounds |
| S-9 | L2 | Rotate and translate handles still pass through unchanged | R/M gizmo | same as before this change |

## F — Faces (`packages/geometry/test/face.test.ts`, `packages/engine/test/face.test.ts`)

| # | Level | Case | Input | Pass |
|---|---|---|---|---|
| F-1 | L1 | A face is zero thickness | `faceMesh({ points: 600×400 square, normal +z })` | `meshVolume` = 0 within 1e-6; `isClosedMesh` = `false` |
| F-2 | L1 | A face has real area and bounds | same square | area 240000 mm²; bounds x 0..600, y 0..400, z = 0 on both sides |
| F-3 | L1 | Triangle count follows the ring | convex 4-point ring, L-shaped 6-point ring | 2 and 4 triangles |
| F-4 | L1 | Indices address the returned positions | any ring with a repeated closing point | every index < `positions.length / 3` |
| F-5 | L1 | Triangles are counter-clockwise seen from +normal | square on +z, triangle on +x | each triangle's cross product has positive dot with `plane.normal` |
| F-6 | L1 | A clockwise ring is flipped, not dropped | same square in reverse order | same 2 triangles, same face normal |
| F-7 | L1 | Fewer than three distinct points throws | `[]`, `[[0,0]]`, `[[0,0],[1,0]]`, `[[0,0],[1,0],[1,0]]` | `RangeError`, message names the face |
| F-8 | L1 | A zero-area ring throws | `[[0,0],[100,0],[200,0]]` | `RangeError`, message says zero area |
| F-9 | L1 | A degenerate face never returns a mesh | F-7 and F-8 inputs | no mesh, no NaN positions |
| F-10 | L1 | Recipe round-trips through save/open | `face` recipe, 4 points + plane | `deserialize(serialize(doc))` equal recipe, volume 0 |
| F-11 | L1 | A saved file is schema 6 | `serialize` a document with a face | `schemaVersion` = 6; `deserialize` walks it with no migration step |
| F-12 | L1 | Push/pull of a face makes a closed solid | 600×400 face, distance 18 | one `loop`/solid mesh, `isClosedMesh` = `true`, volume 4 320 000 mm³ |
| F-13 | L1 | Quantity counts area, not volume | face 600×400, solid 600×400×18 | face quantity 240000, solid quantity 4320000 |
| F-14 | L1 | DXF closed outline imports as a face | closed LWPOLYLINE square | one `face` recipe, 4 points, volume 0 |
| F-15 | L1 | DXF open outline still makes no face | `70` = 0 | `[]`, "no closed polylines" |
| F-16 | L2 | Rectangle tool creates a face, not a 10 mm slab | draw 600×400 | outliner shows a face; Push/Pull is offered |
| F-17 | L2 | Push/pull turns the face into a solid in one undo step | draw face, Push/Pull 18, Ctrl+Z | back to a zero-thickness face; Ctrl+Z again removes it |
| F-18 | L2 | Undo of face creation leaves the document as before | draw face, Ctrl+Z | no solid, envelope and selection unchanged |
| F-19 | L2 | Face save/open round-trip | draw face, save, reload | same point count, same plane, volume 0, area unchanged |
| F-20 | L2 | A face renders from its front and is pickable from both sides | orbit behind the face | lit from +normal, still selectable |
| F-21 | L1 | Migration 5 -> 6 is a no-op that only bumps the version | `{"schemaVersion": 5}` with one `loop` at 10 mm | `schemaVersion` 6; the `loop` is left as a `loop`, not converted to a `face` |
| F-22 | L1 | A 5-file with no face opens with every solid unchanged | a real schema 5 file (`v5-migration.fcproj`) | solids, meta and section equal; volume equal |
| F-23 | L1 | A reader refuses a file newer than itself | `{"schemaVersion": 7}` | throws `/newer version/`, no partial document |
| F-24 | L1 | Push/pull of a face is undone back to the face | `pullFace` on a face, then undo | recipe `kind` = `face` again, same points, same plane, volume 0 |
| F-25 | L1 | `pullBy` on a face uses the delta as the whole distance | 600×400 face, `pullBy(300)` | `distance` 300, volume 72 000 000 mm³, not 300 added to nothing |
| F-26 | L1 | Push/pull of a face by zero or a negative is refused | `pullFace(id, 0)`, `pullFace(id, -18)` | `RangeError`, document and history unchanged |
| F-27 | L2 | The outliner row for a face reads area, not volume | draw 600×400, read the row | `Face - 2400.0 cm2`; a solid row reads `cm3`. `describeExtent` is private to `main.ts`, so only the row text can be asserted |
| F-28 | L2 | The row for a face never reads `0.0 cm3` | draw 600×400, read the row | row contains `cm2` and 2400.0, not `cm3` |

---

## What this plan does not cover (honest limits)

- **Nothing here has been executed yet.** The cases are written against the code
  as it stands; the results table below stays empty until the run is allowed.
- DAE cases (I-30..I-33) need a real `DOMParser`: they belong in the browser
  smoke script, and a fake DOM would prove nothing about XML namespaces.
- Drag-and-drop (I-34), the gizmo (S-6..S-9) and the rail's styling (M-14..M-21)
  need the canvas; they are L2 and currently manual.
- `dae.ts` matrix composition, `<polylist>` with `vcount`, and multiple
  `instance_geometry` placements have **no test** at any level yet.
- No test asserts that a `.fcproj` written by this build opens in an older build:
  schema 6 -> 5 is a one-way door once a face is in the file, and the version
  guard in `deserialize` is the only protection. F-23 covers the guard from this
  side; what a 5 build does with a 6-file is not verified.

## Results

| Date | Run | Command | Result | Notes |
|---|---|---|---|---|
| 2026-11-01 | gate | `.\harness.ps1 verify` | PASS | every check, typecheck 0 errors, 436/436 tests, smoke clean. Adds the Line tool end to end: an open chain is one edge object and one undo step, closing on the start makes a face of the drawn area, typing places nothing until Enter and then exactly 500 mm, Escape leaves nothing. |
| 2026-11-01 | gate | `.\harness.ps1 verify` | PASS | 10/10 checks, typecheck 0 errors, 424/424 tests, smoke clean. Cold start: the smoke step starts Vite on :5198 itself. |
| 2026-10-31 | - | `npm test` | not run | superseded: the loop runs the gate every cycle |


| Date | Run | Command | Result | Notes |
|---|---|---|---|---|
| — | — | `npm test` | not run | deferred: builds and tests are on hold by instruction |
