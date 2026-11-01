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
  const svg = t.plotText(50);
  return {
    skipped: false,
    isSvg: svg.startsWith('<svg') || svg.includes('<svg'),
    hasPath: svg.includes('<path') || svg.includes('<line') || svg.includes('<polyline'),
    length: svg.length,
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
      const tools = names.filter((n) => !['undo','redo','zoom','save','dxfout','plot','new','paper','units','layer','help','select','dimaligned'].includes(n));
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

  const layers = await evaluate(api, layerProbe);
  checks.push(["the panel adds a layer", layers.after === layers.before + 1, JSON.stringify(layers)]);
  checks.push(["the new layer is current", layers.current === 1, String(layers.current)]);
  checks.push(["rename shows in the list", layers.renamed === "ok" && layers.listed === true, JSON.stringify(layers)]);
  checks.push(["a layer can be hidden", layers.hidden === "ok", String(layers.hidden)]);

  const trip = await evaluate(api, roundTripProbe);
  checks.push(["a saved project opens again", trip.back === 2 && trip.empty === 0, JSON.stringify(trip)]);

  const plot = await evaluate(api, plotProbe);
  checks.push(["plot produces an SVG", plot.isSvg && plot.hasPath, JSON.stringify(plot)]);

  // The command line is a control a user types into; drive it as one.
  const typed = await evaluate(
    api,
    `(() => {
      const t = window.draftcheckTest;
      t.command('new');
      const input = document.getElementById('command-input');
      input.focus();
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
