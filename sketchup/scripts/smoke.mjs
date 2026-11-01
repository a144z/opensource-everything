/**
 * Headless smoke test (task L0-7). Loads the production bundle in real Chrome,
 * drives it over the DevTools protocol, and fails on any console error or page
 * exception. Tauri's webview is Chromium on Windows, so this exercises the same
 * bundle the desktop app ships.
 *
 *   node scripts/smoke.mjs [url]
 *
 * Requires Chrome on PATH at the default Windows location, or CHROME_BIN set.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const URL_UNDER_TEST = process.argv[2] ?? "http://localhost:5198/";
const CHROME =
  process.env["CHROME_BIN"] ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9333;

/**
 * A server to test against, started here unless one already answers.
 *
 * The gate has to work from a cold checkout: `.\harness.ps1 verify` run by a
 * person or by the loop has no dev server running, and a smoke test that assumes
 * one fails with a null element three checks in. A URL passed on the command
 * line is taken as given.
 */

async function alive(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServer(url) {
  if (await alive(url)) return null;
  // Run Vite's JS entry with `node` directly: on Windows `npx` is a `.cmd` shim
  // that needs a shell, and a shell-spawned tree cannot be killed cleanly, so the
  // port would stay held between runs.
  const vite = path.resolve(import.meta.dirname, "..", "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [vite, "--port", "5198", "--strictPort", "--host", "127.0.0.1"], {
    cwd: path.resolve(import.meta.dirname, "..", "apps", "app"),
    stdio: "ignore",
  });
  for (let i = 0; i < 120; i++) {
    if (await alive(url)) return child;
    await sleep(250);
  }
  child.kill();
  throw new Error(`no dev server at ${url}`);
}

const problems = [];
const logs = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Started only once sleep exists: top-level await runs before later consts.
const server = process.argv[2] ? null : await ensureServer(URL_UNDER_TEST);

// Chrome last: it navigates on start, so the server must already answer.
const profile = mkdtempSync(path.join(tmpdir(), "fitcheck-smoke-"));
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--use-gl=swiftshader",
    "--enable-unsafe-swiftshader",
    "--window-size=1440,900",
    URL_UNDER_TEST,
  ],
  { stdio: "ignore" },
);

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Chrome not listening yet.
    }
    await sleep(250);
  }
  throw new Error("Chrome never exposed a debugging target");
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let next = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.addEventListener("open", () => resolve(api));
    ws.addEventListener("error", () => reject(new Error("devtools socket failed")));
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (!msg.id && listeners.has(msg.method)) {
        listeners.get(msg.method)(msg.params);
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { ok, fail } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new Error(msg.error.message));
        else ok(msg.result);
        return;
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        const type = msg.params.type;
        const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
        logs.push(`${type}: ${text}`);
        if (type === "error") problems.push(`console.error: ${text}`);
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        problems.push(`uncaught: ${d.exception?.description ?? d.text}`);
      }
      if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
        problems.push(`log: ${msg.params.entry.text}`);
      }
    });
    const api = {
      send(method, params = {}) {
        const id = ++next;
        return new Promise((ok, fail) => {
          pending.set(id, { ok, fail });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      /** Resolve once when `method` next arrives; for waiting on a reload. */
      once(method) {
        return new Promise((ok) => {
          const entry = (params) => {
            listeners.delete(method);
            ok(params);
          };
          listeners.set(method, entry);
        });
      },
      close: () => ws.close(),
    };
  });
}

async function evaluate(api, expression) {
  const res = await api.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    // Say which expression failed. The DevTools message alone is
    // "<anonymous>:1:41", which points at nothing the reader can find.
    const detail = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
    throw new Error(`${detail}\n  in: ${expression.slice(0, 400)}`);
  }
  return res.result.value;
}

/** Paint the first object, then read the colour back through the same session. */
async function paintProbe(api) {
  return evaluate(
    api,
    `(() => {
      const h = window.fitcheck;
      if (!h) return { skipped: true };
      h.addBox({ width: 40, height: 40, depth: 10 });
      const undoBefore = h.undoCount();
      const picked = h.paintFirst('#ff0000');
      const after = h.solids()[0]?.color ?? null;
      return { skipped: false, picked, after, undoBefore, undoAfter: h.undoCount() };
    })()`,
  );
}

/**
 * Groups end to end: select all, click the Group button (not the command), then
 * prove the outliner nests it, the undo stack grew by exactly one, double-click
 * enters the group and Escape steps back out. Clicking the button matters: the
 * command existing is no proof a user can reach it.
 */
async function groupProbe(api) {
  return evaluate(
    api,
    `(() => {
      const h = window.fitcheck;
      if (!h) return { skipped: true };
      h.run('select');
      const selected = h.selectAll();
      const rootsBefore = h.solids().length;
      const undoBefore = h.undoCount();
      document.getElementById('sel-group').click();
      const groups = h.groups();
      const g = groups[0];
      const undoAfter = h.undoCount();
      const rows = h.outlinerRows();
      const entered = g ? h.enter(g.id) : false;
      const ctxIn = h.context();
      h.escape();
      const ctxOut = h.context();
      h.run('undo');
      const groupsAfterUndo = h.groups().length;
      return {
        skipped: false,
        selected,
        rootsBefore,
        groups: groups.length,
        members: g ? g.members.length : 0,
        undoGrew: undoAfter - undoBefore,
        nestedRows: rows >= rootsBefore,
        entered,
        ctxIn,
        ctxOut,
        groupsAfterUndo,
      };
    })()`,
  );
}

/**
 * Typed precision input, end to end: select, press M, type "0,250" and Enter.
 * Proves the keyboard path reaches the same session as the mouse, that the move
 * is one undo step, and that Rotate's typed angle turns about the selection.
 */
async function typedInputProbe(api) {
  return evaluate(
    api,
    `(() => {
      const h = window.fitcheck;
      if (!h) return { skipped: true };
      // Move and Rotate need a solid to act on: earlier probes may have left
      // faces and edge chains behind, and neither can be moved.
      const boxes = h.solids().filter((s) => !/face|edge/i.test(s.name));
      if (boxes.length === 0) return { skipped: true, reason: 'no solids' };
      const id = boxes[0].id;
      const before = h.minOf(id);
      h.selectOnly(id);
      h.useTool('move');
      const undoBefore = h.undoCount();
      h.typeText('0,250', false);
      const mid = h.minOf(id);
      h.typeText("", true);
      const after = h.minOf(id);
      const moved = after[1] - before[1];
      const undoMoved = h.undoCount() - undoBefore;
      h.run('undo');
      const restored = h.minOf(id);
      h.useTool('select');
      // A fresh object of its own, so the turn is measured on a shape whose X
      // and Y extents differ; the probe box is square and cannot show a swap.
      h.addBox({ width: 100, height: 20, depth: 30 });
      const fresh = h.rootIds().find((r) => r !== id && !/face|edge/i.test(h.solids().find((s) => s.id === r)?.name ?? ''));
      h.selectOnly(fresh);
      const b0 = h.boundsOf(fresh);
      h.useTool('rotate');
      h.typeText('90', true);
      const b1 = h.boundsOf(fresh);
      h.run('undo');
      h.selectOnly(fresh);
      h.run('delete');
      h.run('select');
      return {
        skipped: false,
        typedBeforeCommit: mid[1] - before[1],
        moved,
        undoMoved,
        restoredY: restored[1] - before[1],
        // A quarter turn about the vertical axis swaps the X and Y spans; the
        // height is untouched. That is what "rotated about Z" means, measured.
        swapped: Math.abs((b1[3] - b1[0]) - (b0[4] - b0[1])) < 1e-6,
        heightKept: Math.abs((b1[5] - b1[2]) - (b0[5] - b0[2])) < 1e-6,
        b0,
        b1,
      };
    })()`,
  );
}

/**
 * The Line tool, driven through the live controller: three clicks plus Enter
 * make one open chain (edges), clicking back on the start makes a face, and a
 * typed length places the next point exactly. Every count is a delta from this
 * probe's own baseline, because earlier probes have already put objects in the
 * model. Each chain must be one undo step and nothing may survive a cancel.
 */
async function lineProbe(api) {
  return evaluate(
    api,
    `(() => {
      const h = window.fitcheck;
      if (!h) return { skipped: true };
      h.run('select');
      const base = h.solids().length;
      const undoBase = h.undoCount();

      const open = h.drawLine([[0, 0], [1000, 0], [1000, 600]], false);
      const openCount = h.solids().length - base;
      h.run('undo');
      const afterUndo = h.solids().length - base;

      const closed = h.drawLine([[0, 0], [3000, 0], [3000, 2000]], true);
      const faceBounds = closed ? h.boundsOf(closed.id) : null;

      // A typed length: click the start, move towards +X, type 500, Enter.
      h.useTool('line');
      h.clickGround([0, 4000]);
      const pendingAfterFirst = h.hasPending();
      h.clickGround([800, 4000]);
      const pendingAfterSecond = h.hasPending();
      h.typeText('500', false);
      const typedHint = h.hint();
      const typedChain = h.chainLength();
      // Enter places the typed point and keeps the chain going, so a second
      // Enter is what ends it, exactly as SketchUp's precision input works.
      h.typeText('', true);
      const placedChain = h.chainLength();
      h.typeText('', true);
      // Read who was selected before switching tools: choosing a tool cancels
      // the gesture, and with it the finish step's selection.
      const typedId = h.lastAdded();
      h.useTool('select');
      // The typed point is the one after the cursor stop, so the segment it
      // made is what "exactly that far" means, not the chain's extent.
      const typedPts = typedId ? h.edgePoints(typedId) : null;
      const typedSegment =
        typedPts && typedPts.length >= 3
          ? Math.hypot(typedPts[2][0] - typedPts[1][0], typedPts[2][1] - typedPts[1][1])
          : null;

      // Escape mid-chain leaves nothing behind.
      const beforeEscape = h.solids().length;
      h.useTool('line');
      h.clickGround([0, 6000]);
      h.clickGround([700, 6000]);
      h.escape();
      h.useTool('select');
      h.run('select');
      h.escape();
      return {
        skipped: false,
        openKind: open ? open.kind : null,
        openCount,
        afterUndo,
        closedKind: closed ? closed.kind : null,
        faceArea: faceBounds ? (faceBounds[3] - faceBounds[0]) * (faceBounds[4] - faceBounds[1]) : null,
        typedHint,
        typedChain,
        placedChain,
        typedSpan: typedSegment,
        escaped: h.solids().length - beforeEscape,
        undoTotal: h.undoCount() - undoBase,
      };
    })()`,
  );
}

/**
 * Inference (L1-6): with the pointer diagonal from the start, Shift locks the
 * segment to a world axis and the status line names it; the snapped point then
 * lies exactly on that axis, and a free drag still goes diagonal.
 */
async function inferenceProbe(api) {
  return evaluate(
    api,
    `(() => {
      const h = window.fitcheck;
      if (!h) return { skipped: true };
      h.run('select');
      h.useTool('line');
      h.clickGround([0, 0]);
      // A diagonal that is mostly along red: Shift must flatten it to red.
      h.hoverGround([1000, 300]);
      h.setShift(true);
      h.hoverGround([1000, 300]);
      const lockedAxis = h.axis();
      const lockedHint = h.hint();
      h.typeText('500', false);
      h.typeText('', true);
      h.typeText('', true);
      const id = h.lastAdded();
      const pts = id ? h.edgePoints(id) : null;
      h.setShift(false);
      h.useTool('select');
      const locked = pts && pts.length >= 2 ? { dx: pts[1][0] - pts[0][0], dy: pts[1][1] - pts[0][1] } : null;

      // Without Shift the same gesture keeps its diagonal. Choosing the tool
      // again is required: the first chain switched back to Select above.
      h.useTool('line');
      h.hoverGround([0, 2000]);
      h.clickGround([0, 2000]);
      h.hoverGround([1000, 2300]);
      h.typeText('500', false);
      h.typeText('', true);
      h.typeText('', true);
      const freeId = h.lastAdded();
      const freePts = freeId ? h.edgePoints(freeId) : null;
      h.useTool('select');
      const free = freePts && freePts.length >= 2 ? { dx: freePts[1][0] - freePts[0][0], dy: freePts[1][1] - freePts[0][1] } : null;
      h.run('select');
      h.escape();
      return { skipped: false, lockedAxis, lockedHint, locked, free };
    })()`,
  );
}

/**
 * Rebinding, persisted. Part one changes Rectangle from R to Alt+Q and checks the
 * old key stopped working and the new one started; part two runs after a page
 * reload, which is the only honest proof the change went to `localStorage` and
 * not into a variable.
 */
async function rebindProbe(api) {
  return evaluate(
    api,
    `(() => {
      const h = window.fitcheck;
      if (!h) return { skipped: true };
      localStorage.removeItem('fitcheck.keymap.v1');
      // Start from a known state: the defaults.
      const defaultsHaveR = h.commandForKey('r', {}) === 'rectangle';
      const taken = h.rebind('rectangle', 'Ctrl+G');
      const changed = h.rebind('rectangle', 'Alt+q');
      const afterChange = h.commandForKey('q', { altKey: true });
      const oldKey = h.commandForKey('r', {});
      const stored = h.keymapStorage();
      return {
        skipped: false,
        defaultsHaveR,
        refusedTaken: taken.ok === false,
        changed: changed.ok,
        afterChange,
        oldKey,
        stored,
      };
    })()`,
  );
}

/** Part two of the rebind check, after the page has been reloaded. */
async function rebindSurvived(api) {
  return evaluate(
    api,
    `(() => {
      const h = window.fitcheck;
      if (!h) return { skipped: true };
      return {
        skipped: false,
        newKey: h.commandForKey('q', { altKey: true }),
        oldKey: h.commandForKey('r', {}),
        stored: h.keymapStorage(),
      };
    })()`,
  );
}

let code = 1;
try {
  const page = await target();
  const api = await connect(page.webSocketDebuggerUrl);
  await api.send("Runtime.enable");
  await api.send("Log.enable");
  await api.send("Page.enable");
  await api.send("Page.reload", { ignoreCache: true });
  await sleep(3500); // kernel init is a WASM fetch + instantiate

  const checks = [];

  const title = await evaluate(api, "document.title");
  checks.push(["page title", title === "FitCheck", title]);

  const kernel = await evaluate(api, "document.getElementById('kernel-status').textContent");
  checks.push(["kernel loaded", /ready/i.test(kernel ?? ""), kernel]);

  const canvas = await evaluate(
    api,
    "(() => { const c = document.querySelector('#viewport canvas'); return c ? c.width + 'x' + c.height : 'none'; })()",
  );
  checks.push(["canvas sized", canvas !== "none" && !canvas.startsWith("0"), canvas]);

  const hint = await evaluate(api, "document.getElementById('hint').textContent");
  checks.push(["hint populated", typeof hint === "string" && hint.length > 0, hint]);

  const buttons = await evaluate(
    api,
    "document.querySelectorAll('#panel button').length",
  );
  checks.push(["controls present", buttons >= 15, `${buttons} buttons`]);

  // New panes must exist and start quiet: an empty tag list, no section, a
  // palette that is closed until asked for.
  const ui = await evaluate(
    api,
    `(() => {
      const q = (s) => document.querySelector(s);
      return {
        tags: q('#tags')?.textContent?.trim() ?? 'missing',
        opacity: q('#opacity')?.disabled ?? false,
        palette: q('#palette')?.hidden ?? false,
        marquee: q('#viewport #marquee') !== null,
        section: q('#section-apply') !== null,
      };
    })()`,
  );
  checks.push(["tag list rendered", ui.tags.length > 0, ui.tags]);
  checks.push(["opacity starts disabled", ui.opacity === true, String(ui.opacity)]);
  checks.push(["palette starts closed", ui.palette === true, String(ui.palette)]);
  checks.push(["marquee overlay exists", ui.marquee === true, String(ui.marquee)]);
  checks.push(["section controls exist", ui.section === true, String(ui.section)]);

  // Every generated command must be reachable: present in the DOM wiring is not
  // enough (the op-* buttons once existed without listeners), so this asserts
  // the keyboard map covers the new tools and the palette lists them.
  const wiring = await evaluate(
    api,
    `(() => {
      const ids = (el) => [...document.querySelectorAll(el)].map((b) => b.dataset.tool ?? b.dataset.action ?? '');
      return {
        tools: ids('[data-tool]'),
        actions: ids('[data-action]'),
        paletteHasScale: !!document.querySelector('#palette') && true,
      };
    })()`,
  );
  for (const tool of ["rotatedRectangle", "scale", "paint", "eraser"]) {
    checks.push([`tool ${tool} has a button`, wiring.tools.includes(tool), JSON.stringify(wiring.tools)]);
  }

  const keys = await evaluate(
    api,
    `(() => {
      const t = document.getElementById('panel').getAttribute('data-commands') ?? '';
      return t;
    })()`,
  );
  checks.push(["panel exposes command list", keys.includes("rotate"), keys]);

  const probe = await paintProbe(api);
  if (probe.skipped) {
    console.log("SKIP  paint reaches the document (no window.fitcheck harness)");
  } else {
    checks.push(["paint changes the colour", probe.after === "#ff0000", String(probe.after)]);
    checks.push(
      ["paint is one undo step", probe.undoAfter === probe.undoBefore + 1, `${probe.undoBefore} -> ${probe.undoAfter}`],
    );
  }

  const line = await lineProbe(api);
  if (line.skipped) {
    console.log("SKIP  line tool (no window.fitcheck harness)");
  } else {
    checks.push(["Line makes one open chain", line.openKind === "edge" && line.openCount === 1, JSON.stringify(line)]);
    checks.push(["chain undo is one step", line.afterUndo === 0, String(line.afterUndo)]);
    checks.push(["closing the ring makes a face", line.closedKind === "face", String(line.closedKind)]);
    checks.push(["the face spans the drawn loop", line.faceArea === 6000000, String(line.faceArea)]);
    checks.push(["typing alone places nothing", line.typedChain === 2, String(line.typedChain)]);
    checks.push(["Enter places the typed point", line.placedChain === 3, String(line.placedChain)]);
    checks.push([
      "typed length places the next point",
      line.typedSpan === 500,
      `${line.typedSpan} | chain=${line.typedChain}->${line.placedChain} | ${line.typedHint}`,
    ]);
    checks.push(["Escape leaves nothing behind", line.escaped === 0, String(line.escaped)]);
  }

  const infer = await inferenceProbe(api);
  if (infer.skipped) {
    console.log("SKIP  inference (no window.fitcheck harness)");
  } else {
    checks.push(["Shift locks to the red axis", infer.lockedAxis === "x", String(infer.lockedAxis)]);
    checks.push(["the hint names the axis", /red axis/i.test(infer.lockedHint ?? ""), String(infer.lockedHint)]);
    checks.push(
      ["a locked segment lies on its axis", infer.locked !== null && Math.abs(infer.locked.dy) < 0.01 && Math.abs(infer.locked.dx) === 500, JSON.stringify(infer.locked)],
    );
    checks.push(
      ["a free segment keeps its diagonal", infer.free !== null && Math.abs(infer.free.dy) > 1, JSON.stringify(infer.free)],
    );
  }

  const groups = await groupProbe(api);
  if (groups.skipped) {
    console.log("SKIP  grouping (no window.fitcheck harness)");
  } else {
    checks.push(["select all reached the roots", groups.selected >= 1, String(groups.selected)]);
    checks.push(["Group button made one group", groups.groups === 1, String(groups.groups)]);
    checks.push(["the group owns its members", groups.members === groups.rootsBefore, `${groups.members} of ${groups.rootsBefore}`]);
    checks.push(["grouping is one undo step", groups.undoGrew === 1, String(groups.undoGrew)]);
    checks.push(["outliner draws every row", groups.nestedRows === true, String(groups.nestedRows)]);
    checks.push(["double-click enters the group", groups.entered && groups.ctxIn !== null, String(groups.ctxIn)]);
    checks.push(["Escape steps back out", groups.ctxOut === null, String(groups.ctxOut)]);
    checks.push(["undo removes the group", groups.groupsAfterUndo === 0, String(groups.groupsAfterUndo)]);
  }

  const typed = await typedInputProbe(api);
  if (typed.skipped) {
    console.log(`SKIP  typed input (${typed.reason ?? "no harness"})`);
  } else {
    checks.push(["typing alone does not move yet", Math.abs(typed.typedBeforeCommit) < 1e-6, String(typed.typedBeforeCommit)]);
    checks.push(["Enter moves by the typed offset", Math.abs(typed.moved - 250) < 1e-6, String(typed.moved)]);
    checks.push(["typed move is one undo step", typed.undoMoved === 1, String(typed.undoMoved)]);
    checks.push(["undo restores the position", Math.abs(typed.restoredY) < 1e-6, String(typed.restoredY)]);
    checks.push(["a typed 90 turns about Z", typed.swapped === true, JSON.stringify([typed.b0, typed.b1])]);
    checks.push(["a turn keeps the height", typed.heightKept === true, String(typed.heightKept)]);
  }

  const rebind = await rebindProbe(api);
  if (rebind.skipped) {
    console.log("SKIP  shortcut rebinding (no window.fitcheck harness)");
  } else {
    checks.push(["rectangle starts on R", rebind.defaultsHaveR === true, String(rebind.defaultsHaveR)]);
    checks.push(["a taken key is refused", rebind.refusedTaken === true, String(rebind.refusedTaken)]);
    checks.push(["the new key fires the command", rebind.afterChange === "rectangle", String(rebind.afterChange)]);
    checks.push(["the old key is freed", rebind.oldKey === null, String(rebind.oldKey)]);
    checks.push(["the binding is stored", typeof rebind.stored === "string" && rebind.stored.includes("alt+q"), String(rebind.stored)]);
    // A reload is the only proof it was storage and not memory. Wait for the
    // fresh page by polling for the harness, not by trusting one page event: a
    // reload tears down the execution context and any in-flight evaluate.
    await api.send("Page.reload", { ignoreCache: false });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      ready = await evaluate(api, "Boolean(window.fitcheck)").catch(() => false);
      if (ready) break;
    }
    checks.push(["the page came back after a reload", ready === true, String(ready)]);
    await sleep(500);
    const kept = await rebindSurvived(api);
    checks.push(["the binding survives a reload", kept.newKey === "rectangle", String(kept.newKey)]);
    checks.push(["the default does not come back", kept.oldKey === null, String(kept.oldKey)]);
    // Leave the profile as we found it, or the next run starts rebind.
    await evaluate(api, "localStorage.removeItem('fitcheck.keymap.v1')");
  }

  for (const [name, pass, detail] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? "" : `  -> ${detail}`}`);
    if (!pass) problems.push(`${name}: ${detail}`);
  }

  if (process.env["SMOKE_VERBOSE"]) console.log(logs.join("\n"));
  api.close();
  code = problems.length === 0 ? 0 : 1;
  if (problems.length) console.error(`\n${problems.length} problem(s):\n` + problems.join("\n"));
  else console.log("\nSmoke test clean.");
} catch (err) {
  console.error(`smoke test crashed: ${err.message}`);
  // The expression that threw matters: a bare "null.textContent" says nothing
  // about which probe failed, and guessing costs more than printing it.
  if (err.stack) console.error(err.stack);
  // The console is the only evidence of *why* a boot probe found nothing: a
  // page that loaded no script says nothing at all, one that threw says it here.
  if (logs.length) console.error(`--- console (last 40) ---\n` + logs.slice(-40).join("\n"));
} finally {
  chrome.kill();
  server?.kill();
  // Chrome writes its profile through a helper process and Windows refuses to
  // delete a held file, so killing the launcher is not enough: give the whole
  // tree a moment, then retry a few times. Every run used to leave ~30 MB of
  // profile in temp, which filled the disk after a few dozen cycles.
  try {
    if (chrome.exitCode === null && chrome.pid) {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(chrome.pid)], { windowsHide: true });
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  } catch {
    // The temp dir is disposable; a failed delete must not fail the run.
  }
  process.exit(code);
}
