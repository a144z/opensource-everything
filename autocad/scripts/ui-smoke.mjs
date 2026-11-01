/**
 * UI smoke: loads the DraftCheck bundle in real Chrome, drives it through the
 * DevTools protocol, and fails on any console error or page exception.
 *
 *   node scripts/ui-smoke.mjs [url]
 *
 * Every drawing check goes through `window.draftcheckTest`, which is the same
 * `Runner` the mouse and the command line feed. Where a check can press the real
 * button instead, it does: a command that exists but has no listener is not a
 * feature, and only a click proves the difference.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 5201;
const URL_UNDER_TEST = process.argv[2] ?? `http://127.0.0.1:${PORT}/`;
const CHROME = process.env["CHROME_BIN"] ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9334;
const APP = path.resolve(import.meta.dirname, "..", "apps", "app");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const logs = [];

async function alive(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Serve the app. `vite preview` on the built bundle is what a user runs, and it
 * needs no transform step, so the gate is checking the artifact, not the source.
 */
async function ensureServer() {
  if (await alive(URL_UNDER_TEST)) return null;
  if (!existsSync(path.join(APP, "dist", "index.html"))) {
    throw new Error("apps/app/dist is missing: run the build step first");
  }
  const vite = path.join(APP, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(
    process.execPath,
    [vite, "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: APP, stdio: "ignore" },
  );
  for (let i = 0; i < 120; i++) {
    if (await alive(URL_UNDER_TEST)) return child;
    await sleep(250);
  }
  child.kill();
  throw new Error(`no preview server at ${URL_UNDER_TEST}`);
}

const server = await ensureServer();

if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME_BIN)`);

const profile = mkdtempSync(path.join(tmpdir(), "draftcheck-ui-"));
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--window-size=1440,900",
    URL_UNDER_TEST,
  ],
  { stdio: "ignore" },
);

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
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
    ws.addEventListener("open", () => resolve(api));
    ws.addEventListener("error", () => reject(new Error("devtools socket failed")));
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && pending.has(msg.id)) {
        const { ok, fail } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new Error(msg.error.message));
        else ok(msg.result);
        return;
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
        logs.push(`${msg.params.type}: ${text}`);
        if (msg.params.type === "error") problems.push(`console.error: ${text}`);
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
      close: () => ws.close(),
    };
  });
}

async function evaluate(api, expression) {
  const res = await api.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) {
    const detail = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
    throw new Error(`${detail}\n  in: ${expression.slice(0, 300)}`);
  }
  return res.result.value;
}

/**
 * Draw a line chain by typing, the way a drafter does: L, point, point…
 * Esc ends the run, as it does for a user.
 */
const drawLineProbe = `
(() => {
  const t = window.draftcheckTest;
  if (!t) return { skipped: true };
  t.command('new');
  const base = t.doc().entities.size;
  t.command('line');
  t.command('0,0');
  t.command('100,0');
  t.command('100,80');
  document.getElementById('command-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return { skipped: false, added: t.doc().entities.size - base, hint: t.hint(), prompt: t.runner.prompt };
})()`;

/**
 * The grid snap is on by default; that is what "typed 100,0 lands at 100,0"
 * has to survive, so the geometry is read back, not the hint.
 */
const geometryProbe = `
(() => {
  const t = window.draftcheckTest;
  if (!t) return { skipped: true };
  const lines = [...t.doc().entities.values()].filter((e) => e.kind === 'line');
  const ends = lines.map((l) => [l.a.x, l.a.y, l.b.x, l.b.y]);
  return { skipped: false, count: lines.length, ends };
})()`;

/** Esc must leave the document alone and put the prompt back to idle. */
const cancelProbe = `
(() => {
  const t = window.draftcheckTest;
  if (!t) return { skipped: true };
  const before = t.doc().entities.size;
  t.command('circle');
  t.command('0,0');
  const typing = t.runner.prompt !== null;
  document.getElementById('command-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return { skipped: false, typing, after: t.doc().entities.size, prompt: t.runner.prompt, before };
})()`;

/** Undo/redo across a whole typed gesture. */
const undoProbe = `
(() => {
  const t = window.draftcheckTest;
  if (!t) return { skipped: true };
  t.command('new');
  t.command('rect');
  t.command('0,0');
  t.command('400,300');
  const drawn = t.doc().entities.size;
  document.getElementById('undo').click();
  const undone = t.doc().entities.size;
  document.getElementById('redo').click();
  const redone = t.doc().entities.size;
  return { skipped: false, drawn, undone, redone };
})()`;

/**
 * A typed dimension drives the geometry: a rectangle's top edge is dimensioned,
 * the value is typed, and the rectangle must grow to match it. This is the whole
 * point of a parametric drawing, so it is measured, not trusted.
 */
const dimensionProbe = `
(() => {
  const t = window.draftcheckTest;
  if (!t) return { skipped: true };
  t.command('new');
  t.command('rect');
  t.command('0,0');
  t.command('400,300');
  // The rectangle is a closed polyline with its points at the corners, so the
  // dimension origins land on an entity and the measurement has a target.
  t.command('dimlinear');
  t.command('0,300');
  t.command('400,300');
  t.command('200,400');
  const dim = [...t.doc().entities.values()].find((e) => e.kind === 'dimension');
  if (!dim) return { skipped: false, dim: null };
  const spanX = () => {
    const xs = [...t.doc().entities.values()].flatMap((e) => {
      if (e.kind === 'line') return [e.a.x, e.b.x];
      if (e.kind === 'polyline') return e.points.map((p) => p.x);
      if (e.kind === 'circle') return [e.center.x - e.radius, e.center.x + e.radius];
      return [];
    });
    return xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  };
  const before = spanX();
  const drive = t.driveDimension(dim.id, 600);
  const after = spanX();
  return { skipped: false, drive, before, after, dim: dim.id };
})()`;

/**
 * A-02, the user's gesture: click the dimension, type the value. Four things
 * have to hold — the geometry lands on the number, the number is one undo
 * step, an impossible value keeps the drawing and says so, and every driving
 * dimension has a glyph beside it.
 */
const dimensionEditProbe = `
(() => {
  const t = window.draftcheckTest;
  if (!t) return { skipped: true };
  t.command('new');
  t.command('new');
  t.command('rect');
  t.command('0,0');
  t.command('400,300');
  t.command('dimlinear');
  t.command('0,300');
  t.command('400,300');
  t.command('200,400');
  const dim = [...t.doc().entities.values()].find((e) => e.kind === 'dimension');
  if (!dim) return { skipped: false, dim: null };
  const poly = () => [...t.doc().entities.values()].find((e) => e.kind === 'polyline');
  const xs = () => {
    const p = poly();
    return p ? p.points.map((q) => q.x) : [];
  };
  const width = () => { const a = xs(); return a.length ? Math.max(...a) - Math.min(...a) : 0; };

  const glyphsBefore = t.glyphs().length;

  // Click the dimension text (it sits above the edge at 200,400), then type.
  t.clickAt(200, 400);
  const prompt = document.getElementById('prompt-label').textContent;
  t.command('600');
  const afterType = width();

  const history = t.doc && t.version();  const undo = t.app.undo();
  const afterUndo = width();
  const redo = t.app.redo();
  const afterRedo = width();

  // Impossible: the second extension line points at a corner the solve cannot
  // reach if we detach it — drive to a negative value instead, which is refused.
  const before = t.dump();
  const hint = t.editDimension(dim.id, '-50');
  const unchanged = t.dump() === before;
  const glyphWeird = t.editDimension(dim.id, 'nothing');
  const stillUnchanged = t.dump() === before;

  return {
    skipped: false,
    prompt,
    afterType,
    history,
    undo,
    afterUndo,
    redo,
    afterRedo,
    /* one undo step: a single undo restores the pre-edit width */
    undoWentBack: Math.abs(afterUndo - 400) < 1e-6,
    hint,
    unchanged,
    glyphWeird,
    stillUnchanged,
    glyphsBefore,
    glyphsAfter: t.glyphs().length,
    glyphText: t.glyphs().map((g) => g.text),
  };
})()`;

/** Layers: create through the panel input, rename through the test surface. */
const layerProbe = `
(() => {
  const t = window.draftcheckTest;
  if (!t) return { skipped: true };
  t.command('new');
  const before = t.layers().length;
  const field = document.getElementById('layer-new');
  field.value = 'Walls';
  document.getElementById('layer-add').click();
  const added = t.layers();
  const current = t.layers().filter((l) => l.endsWith('*')).length;
  const renamed = t.renameLayer('Walls', 'Partitions');
  const listed = document.getElementById('layers').textContent.includes('Partitions');
  const hidden = t.toggleLayer('Partitions', 'visible');
  return { skipped: false, before, added, current, renamed, listed, hidden, after: t.layers().length };
})()`;

/**
 * Round trip through the file format the user actually keeps: save the project,
 * open the saved text in a fresh document, and compare entity counts.
 */
const roundTripProbe = `
(async () => {
  const t = window.draftcheckTest;
  if (!t) return { skipped: true };
  t.command('new');
  t.command('line');
  t.command('0,0');
  t.command('250,0');
  t.command('0,250');
  document.getElementById('command-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const saved = JSON.stringify({ order: t.doc().order, entities: [...t.doc().entities.values()] });
  const text = await t.projectText();
  t.command('new');
  const empty = t.doc().entities.size;
  await t.openText(text, 'project');
  const prompt = t.runner.prompt;
  const back = t.doc().entities.size;
  return { skipped: false, text: text.length > 50, empty, back, prompt };
})()`;

/** Plotting writes an SVG whose viewBox matches the paper, not the screen. */
const plotProbe = `
(() => {
  const t = window.draftcheckTest;
  if (!t) return { skipped: true };
  t.command('new');
  t.command('rect');
  t.command('0,0');
  t.command('400,300');
  t.command('Escape');
  const svg = t.plotText(50);
  return {
    skipped: false,
    isSvg: svg.startsWith('<svg') || svg.includes('<svg'),
    hasPath: svg.includes('<path') || svg.includes('<line') || svg.includes('<polyline'),
    length: svg.length,
  };
})()`;

/**
 * A-03: sheets and plotting. A 1000 mm line on an A3 at 1:50 must be 20 mm of
 * ink, the title block must say so, the preview must be the same drawing the
 * export writes, and the export must not go through the download prompt.
 */
const sheetPlotProbe = `
(async () => {
  const t = window.draftcheckTest;
  if (!t) return { skipped: true };
  t.command('new');
  t.command('line');
  t.command('0,0');
  t.command('1000,0');
  t.command('Escape');

  const set = t.setSheet({ paper: 'A3', scale: 50, title: 'Test sheet', notes: ['Drawn by the smoke'] });
  const sheet = t.sheet();
  const panelPaper = document.getElementById('sheet-paper').value;
  const panelScale = document.getElementById('sheet-scale').value;
  const panelTitle = document.getElementById('sheet-title').value;

  // 1:50 exactness, measured in the exported SVG itself, not in the model.
  const svg = t.plotText(50);
  const svg2 = t.plotText(50);
  const info = t.sheetPlotInfo(50);
  const lines = [...svg.matchAll(/<line x1="([-\\d.]+)" y1="([-\\d.]+)" x2="([-\\d.]+)" y2="([-\\d.]+)"/g)];
  let longest = 0;
  for (const m of lines) {
    const dx = Number(m[3]) - Number(m[1]);
    const dy = Number(m[4]) - Number(m[2]);
    longest = Math.max(longest, Math.hypot(dx, dy));
  }
  const has20mm = lines.some((m) => Math.abs(Math.hypot(Number(m[3]) - Number(m[1]), Number(m[4]) - Number(m[2])) - 20) < 0.01);
  const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\\/text>/g)].map((m) => m[1]);

  const pdf = t.pdfText(50);
  const pdfOk = pdf.startsWith('%PDF-1.4') && pdf.trimEnd().endsWith('%%EOF') && pdf.includes('/MediaBox');

  // Preview must be the export, character for character apart from the DOM.
  const opened = t.previewOpen();
  const preview = t.previewText();
  t.previewClose();
  // The browser re-serialises what it parsed; comparing the drawing content
  // (lines and text, sorted) is the honest test that it is the same sheet.
  // (The browser writes <line ...></line> where the exporter writes <line .../>, so
  // normalise the closing syntax before comparing.)
  const tidy = (x) => x.replace(/\\s+/g, ' ').trim().replace(/\\/?>$/, '').replace(/<\\/(line|text)>$/, '') + '>';
  const shape = (s) => ({
    lines: (s.match(/<line [^>]*>/g) || []).map(tidy).sort(),
    texts: (s.match(/<text[^>]*>[^<]*<\\/text>/g) || []).map(tidy).sort(),
  });
  const ps = shape(preview);
  const ss = shape(svg);
  const sameShape = preview.length > 0 && ps.lines.join() === ss.lines.join() && ps.texts.join() === ss.texts.join();
  const previewLen = preview.length;
  const svgLen = svg.length;
  const lineDiff = ps.lines.join() !== ss.lines.join();
  const textDiff = ps.texts.join() !== ss.texts.join();

  // Export without a prompt: showSaveFilePicker is the browser's save dialog.
  let pickerCalled = false;
  const realPicker = window.showSaveFilePicker;
  window.showSaveFilePicker = async (opts) => {
    pickerCalled = true;
    return {
      createWritable: async () => ({ write: async () => {}, close: async () => {} }),
      name: (opts && opts.suggestedName) || '',
    };
  };
  let exportMsg = '';
  try {
    exportMsg = await t.exportPlot('pdf', 50);
  } finally {
    window.showSaveFilePicker = realPicker;
  }
  let promptOk = false;
  try {
    promptOk = typeof window.showSaveFilePicker === 'function';
  } catch (e) { promptOk = false; }
  return {
    skipped: false,
    stable: svg === svg2,
    notes: sheet.notes,
    setOk: set.ok, sheet, panelPaper, panelScale, panelTitle,
    has20mm, longest, info, texts, pdfOk, pdfLen: pdf.length,
    opened, previewMatches: sameShape, previewLen, svgLen, lineDiff, textDiff, pvLines: ps.lines.length, svgLines: ss.lines.length,
    pickerCalled, exportMsg, promptOk,
  };
})()`;

let code = 1;
try {
  const page = await target();
  if (process.env["SMOKE_ONLY"]) {
    const api = await connect(page.webSocketDebuggerUrl);
    await api.send("Runtime.enable");
    await api.send("Log.enable");
    await api.send("Page.reload", { ignoreCache: true });
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      if (await evaluate(api, "Boolean(window.draftcheckTest)").catch(() => false)) break;
    }
    console.log(JSON.stringify(await evaluate(api, process.env["SMOKE_ONLY"]), null, 2));
    console.log(logs.slice(-20).join("\n"));
    api.close();
    process.exit(0);
  }
  const api = await connect(page.webSocketDebuggerUrl);
  await api.send("Runtime.enable");
  await api.send("Log.enable");
  await api.send("Page.enable");
  await api.send("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    const ready = await evaluate(api, "Boolean(window.draftcheckTest)").catch(() => false);
    if (ready) break;
  }

  const checks = [];
  const title = await evaluate(api, "document.title");
  checks.push(["page title", title === "DraftCheck", title]);

  const canvas = await evaluate(api, "(() => { const c = document.getElementById('viewport'); return c ? c.width + 'x' + c.height : 'none'; })()");
  checks.push(["canvas sized", canvas !== "none" && !canvas.startsWith("0"), canvas]);

  const hint = await evaluate(api, "document.getElementById('hint').textContent");
  checks.push(["hint populated", typeof hint === "string" && hint.length > 0, hint]);

  const status = await evaluate(api, "document.getElementById('status').textContent");
  checks.push(["status bar populated", typeof status === "string" && status.includes("entities"), status]);

  // Every engine command the command line knows must also have a button.
  const reachable = await evaluate(
    api,
    `(() => {
      const t = window.draftcheckTest;
      const buttons = new Set([...document.querySelectorAll('[data-cmd]')].map((b) => b.dataset.cmd));
      const names = (document.getElementById('viewport').dataset.commands ?? '').split(',').filter(Boolean);
      const tools = names.filter((n) => !['undo','redo','zoom','save','dxfout','plot','new','paper','units','layer','help','select','dimaligned','pdf','preview','sheet'].includes(n));
      return { tools, missing: tools.filter((n) => !buttons.has(n) || !t) };
    })()`,
  );
  checks.push(["every tool has a button", reachable.missing.length === 0, JSON.stringify(reachable.missing)]);
  checks.push(["the tool table is not empty", reachable.tools.length >= 20, String(reachable.tools.length)]);

  // Commands must start from a real click, not only from `command()`.
  const clicked = await evaluate(
    api,
    `(() => {
      const t = window.draftcheckTest;
      t.command('new');
      const before = t.doc().entities.size;
      document.querySelector('[data-cmd="rect"]').click();
      const promptUp = t.runner.prompt !== null;
      t.command('0,0');
      t.command('100,50');
      return { promptUp, added: t.doc().entities.size - before };
    })()`,
  );
  checks.push(["the Rect button starts the tool", clicked.promptUp === true, String(clicked.promptUp)]);
  checks.push(["the Rect button drew a rectangle", clicked.added > 0, String(clicked.added)]);

  const line = await evaluate(api, drawLineProbe);
  checks.push(["Line draws two segments from three points", line.added === 2, JSON.stringify(line)]);

  const geo = await evaluate(api, geometryProbe);
  checks.push([
    "typed coordinates are exact",
    JSON.stringify(geo.ends) === JSON.stringify([[0, 0, 100, 0], [100, 0, 100, 80]]),
    JSON.stringify(geo.ends),
  ]);

  const cancel = await evaluate(api, cancelProbe);
  checks.push(["Esc cancels a circle", cancel.prompt === null && cancel.after === cancel.before, JSON.stringify(cancel)]);

  const undo = await evaluate(api, undoProbe);
  checks.push(["undo removes the rectangle", undo.undone === undo.drawn - 1, JSON.stringify(undo)]);
  checks.push(["redo puts it back", undo.redone === undo.drawn, JSON.stringify(undo)]);

  const dim = await evaluate(api, dimensionProbe);
  checks.push(["a typed dimension drives the geometry", dim.skipped || (dim.drive === "ok" && Math.abs(dim.after - 600) < 0.5), JSON.stringify(dim)]);
  const edit = await evaluate(api, dimensionEditProbe);
  if (edit.skipped) {
    checks.push(["click a dimension and type the value", false, "no test surface"]);
  } else {
    checks.push(["a dimension click opens the value prompt", /new value/i.test(edit.prompt ?? ""), edit.prompt]);
    checks.push(["typing the value moves the geometry to it", Math.abs(edit.afterType - 600) < 0.5, edit.afterType]);
    checks.push(["the edit is one undo step", edit.undoWentBack && Math.abs(edit.afterRedo - 600) < 0.5, JSON.stringify(edit)]);
    checks.push(["an impossible value keeps the drawing and says why", edit.unchanged && edit.stillUnchanged && /greater than zero/i.test(edit.hint ?? ""), JSON.stringify(edit)]);
    checks.push(["constraint glyphs sit next to driving dimensions", edit.glyphsBefore >= 1 && edit.glyphsAfter >= 1 && edit.glyphText.every((s) => /\d/.test(s) && /mm/.test(s)), JSON.stringify(edit.glyphText)]);
  }

  const layers = await evaluate(api, layerProbe);
  checks.push(["the panel adds a layer", layers.after === layers.before + 1, JSON.stringify(layers)]);
  checks.push(["the new layer is current", layers.current === 1, String(layers.current)]);
  checks.push(["rename shows in the list", layers.renamed === "ok" && layers.listed === true, JSON.stringify(layers)]);
  checks.push(["a layer can be hidden", layers.hidden === "ok", String(layers.hidden)]);

  const trip = await evaluate(api, roundTripProbe);
  checks.push(["a saved project opens again", trip.back === 2 && trip.empty === 0, JSON.stringify(trip)]);

  const plot = await evaluate(api, plotProbe);
  checks.push(["plot produces an SVG", plot.isSvg && plot.hasPath, JSON.stringify(plot)]);
  const sheetPlot = await evaluate(api, sheetPlotProbe);
  if (sheetPlot.skipped) {
    checks.push(["the sheet panel sets the sheet", false, "no test surface"]);
  } else {
    checks.push([
      "the sheet panel sets paper, scale and title",
      sheetPlot.setOk && sheetPlot.panelPaper === "A3" && sheetPlot.panelScale === "50" && sheetPlot.panelTitle === "Test sheet",
      JSON.stringify({ paper: sheetPlot.panelPaper, scale: sheetPlot.panelScale, title: sheetPlot.panelTitle }),
    ]);
    checks.push([
      "1000 mm at 1:50 plots as exactly 20 mm",
      sheetPlot.has20mm && Math.abs(sheetPlot.info.scale - 50) < 1e-6 && sheetPlot.info.fitted === false,
      JSON.stringify({ longest: sheetPlot.longest, info: sheetPlot.info }),
    ]);
    checks.push([
      "the chosen scale and sheet size appear in the title block",
      sheetPlot.texts.includes("SCALE 1:50") && sheetPlot.texts.some((x) => /A3 420 x 297 mm/.test(x)) && sheetPlot.texts.includes("Test sheet") && sheetPlot.texts.includes("Drawn by the smoke"),
      JSON.stringify(sheetPlot.texts),
    ]);
    checks.push(["plot preview matches the exported file", sheetPlot.opened && sheetPlot.previewMatches, JSON.stringify({ opened: sheetPlot.opened, match: sheetPlot.previewMatches, lineDiff: sheetPlot.lineDiff, textDiff: sheetPlot.textDiff, pvLines: sheetPlot.pvLines, svgLines: sheetPlot.svgLines })]);
    checks.push(["PDF export is a real PDF", sheetPlot.pdfOk, sheetPlot.pdfLen]);
    checks.push([
      "export goes through the save dialog, not the download prompt",
      sheetPlot.pickerCalled && /Exported/.test(sheetPlot.exportMsg),
      JSON.stringify({ picker: sheetPlot.pickerCalled, msg: sheetPlot.exportMsg }),
    ]);
  }

  // The command line is a control a user types into; drive it as one.
  const typed = await evaluate(
    api,
    `(() => {
      const t = window.draftcheckTest;
      // A known start: no tool running, an empty drawing.
      const input = document.getElementById('command-input');
      input.focus();
      input.value = '';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const preview = document.getElementById('preview');
      if (preview && !preview.hidden) document.getElementById('preview-close').click();
      t.command('new');
      input.value = 'l';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const started = t.runner.prompt !== null;
      input.value = '0,0';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.value = '@50,0';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const lines = [...t.doc().entities.values()].filter((e) => e.kind === 'line');
      t.command('line');
      document.getElementById('command-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { started, lines: lines.length, span: lines[0] ? lines[0].b.x - lines[0].a.x : null };
    })()`,
  );
  checks.push(["typing L in the command line starts Line", typed.started === true, String(typed.started)]);
  checks.push(["relative @50,0 draws 50 mm", typed.span === 50, String(typed.span)]);

  for (const [name, pass, detail] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? "" : `  -> ${detail}`}`);
    if (!pass) problems.push(`${name}: ${detail}`);
  }

  if (process.env["SMOKE_VERBOSE"]) console.log(logs.join("\n"));
  api.close();
  code = problems.length === 0 ? 0 : 1;
  if (problems.length) console.error(`\n${problems.length} problem(s):\n` + problems.join("\n"));
  else console.log("\nUI smoke PASS");
} catch (err) {
  console.error(`ui smoke crashed: ${err.message}`);
  if (err.stack) console.error(err.stack);
  if (logs.length) console.error(`--- console (last 40) ---\n` + logs.slice(-40).join("\n"));
} finally {
  chrome.kill();
  server?.kill();
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome may still hold a handle; the temp dir is disposable.
  }
  process.exit(code);
}
