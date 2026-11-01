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

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const URL_UNDER_TEST = process.argv[2] ?? "http://localhost:5198/";
const CHROME =
  process.env["CHROME_BIN"] ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9333;

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

const problems = [];
const logs = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  }
  return res.result.value;
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
} finally {
  chrome.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome may still hold a handle; the temp dir is disposable.
  }
  process.exit(code);
}
