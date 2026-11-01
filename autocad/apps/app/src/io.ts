import type { DocumentState, PlotOptions } from "@apexus/cad";
import {
  deserializeProjectText,
  drawingBounds,
  formatScale,
  plotLayout,
  plotPdf,
  plotSvg,
  readDxf,
  serializeProjectJson,
  sheetOf,
  writeDxf,
} from "@apexus/cad";
import type { AppState } from "./state.js";

/**
 * Files in and out: the .dwgcad project (lossless), DXF (exchange) and SVG
 * (plot). Browser downloads are the fallback; a Tauri build installs its own
 * `saveFile` on `window.draftcheck`, so the desktop app exports without a
 * download prompt while this file keeps one code path for both.
 */
declare global {
  interface Window {
    draftcheck?: {
      saveFile?(name: string, data: string, mime: string): Promise<boolean> | boolean;
      openFile?(accept: string): Promise<string | null> | string | null;
    };
  }
}

export interface FileSink {
  save(name: string, text: string, mime: string): Promise<void>;
}

const browserSink: FileSink = {
  async save(name, text, mime) {
    const native = window.draftcheck?.saveFile;
    if (native) {
      await native(name, text, mime);
      return;
    }
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },
};

export const files: FileSink = browserSink;

/** What opening a file did, in words: nothing is ever silently dropped. */
export interface OpenResult {
  readonly doc: DocumentState | null;
  readonly message: string;
}

export function openProject(text: string): OpenResult {
  try {
    return { doc: deserializeProjectText(text), message: "Project opened" };
  } catch (error) {
    return { doc: null, message: error instanceof Error ? error.message : String(error) };
  }
}

export function openDxfText(text: string): OpenResult {
  const r = readDxf(text);
  const count = r.doc.entities.size;
  const skipped = r.skipped.length ? ` (skipped ${r.skipped.slice(0, 4).join(", ")}${r.skipped.length > 4 ? "…" : ""})` : "";
  return { doc: r.doc, message: `DXF opened: ${count} entities${skipped}` };
}

export async function saveProject(app: AppState, name = "drawing.dwgcad"): Promise<string> {
  await files.save(name, serializeProjectJson(app.doc), "application/json");
  return `Saved ${name}`;
}

export async function saveDxf(app: AppState, name = "drawing.dxf"): Promise<string> {
  await files.save(name, writeDxf(app.doc), "application/dxf");
  return `Exported ${name}`;
}

/**
 * Plot options the preview and both exports share: the drawing bounds, the
 * sheet from the document, and the nominal scale. `sheet` defaults from the
 * document's first layout, so what is plotted is what the Layout tab shows.
 */
export function plotOptions(app: AppState, scale?: number): PlotOptions | null {
  const window = drawingBounds(app.doc);
  if (!window) return null;
  const sheet = sheetOf(app.doc);
  return {
    scale: 1 / (scale ?? sheet.scale),
    paper: { width: sheet.width, height: sheet.height },
    window,
    ...(sheet.margin !== undefined ? { margin: sheet.margin } : {}),
    border: sheet.border,
    sheet: { ...sheet, scale: scale ?? sheet.scale },
  };
}

/** Where the drawing lands on paper, for the preview and the status line. */
export function plotInfo(app: AppState, scale?: number): { scale: number; fitted: boolean; width: number; height: number } | null {
  const opts = plotOptions(app, scale);
  if (!opts) return null;
  const layout = plotLayout(opts);
  return { scale: layout.actual, fitted: layout.fitted, width: opts.paper.width, height: opts.paper.height };
}

export type PlotFormat = "svg" | "pdf";

export function plotText(app: AppState, format: PlotFormat = "svg", scale?: number): string {
  const opts = plotOptions(app, scale);
  if (!opts) return "";
  return format === "pdf" ? plotPdf(app.doc, opts) : plotSvg(app.doc, opts);
}

const EXT: Record<PlotFormat, { ext: string; mime: string }> = {
  svg: { ext: "svg", mime: "image/svg+xml" },
  pdf: { ext: "pdf", mime: "application/pdf" },
};

/** File name for a plot: the title, made safe, plus the scale and extension. */
export function plotName(app: AppState, format: PlotFormat, scale?: number): string {
  const sheet = sheetOf(app.doc);
  const base = (sheet.title || "drawing").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "drawing";
  return `${base}-1-${formatScale(scale ?? sheet.scale)}.${EXT[format].ext}`;
}

export async function plotDrawing(app: AppState, format: PlotFormat = "svg", scale?: number): Promise<string> {
  const text = plotText(app, format, scale);
  if (!text) return "Nothing to plot: the drawing is empty";
  const name = plotName(app, format, scale);
  await files.save(name, text, EXT[format].mime);
  const info = plotInfo(app, scale);
  const note = info?.fitted ? ` (shrunk to fit: 1:${formatScale(info.scale)})` : "";
  return `Plotted ${name} at 1:${formatScale(scale ?? sheetOf(app.doc).scale)}${note}`;
}

/**
 * Save without a download prompt where the platform allows it.
 *
 * `showSaveFilePicker` is the browser's own "save as" dialog: the file goes
 * straight to where the user puts it, with no Downloads folder and no second
 * click. Everywhere else (and on any error other than the user cancelling)
 * this falls through to the download sink, which is what a browser can do.
 * `window.draftcheck.saveFile` wins when a desktop shell provides it.
 */
const promptFreeSink: FileSink = {
  async save(name, text, mime) {
    const native = window.draftcheck?.saveFile;
    if (native) {
      await native(name, text, mime);
      return;
    }
    const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
    if (!picker) {
      await browserSink.save(name, text, mime);
      return;
    }
    try {
      const handle = await picker({
        suggestedName: name,
        types: [{ description: mime, accept: { [mime]: [`.${name.split(".").pop() ?? "txt"}`] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      await browserSink.save(name, text, mime);
    }
  },
};

export const filesPromptFree: FileSink = promptFreeSink;

/** Save a plot with the prompt-free path; reports "cancelled" without an error. */
export async function exportPlot(app: AppState, format: PlotFormat = "pdf", scale?: number): Promise<string> {
  const text = plotText(app, format, scale);
  if (!text) return "Nothing to plot: the drawing is empty";
  const name = plotName(app, format, scale);
  try {
    const native = window.draftcheck?.saveFile;
    if (native) {
      const ok = await native(name, text, EXT[format].mime);
      return ok === false ? "Plot cancelled" : `Exported ${name}`;
    }
    await filesPromptFree.save(name, text, EXT[format].mime);
    const info = plotInfo(app, scale);
    const note = info?.fitted ? `, shrunk to fit at 1:${formatScale(info.scale)}` : "";
    return `Exported ${name} at 1:${formatScale(scale ?? sheetOf(app.doc).scale)}${note}`;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return "Plot cancelled";
    throw error;
  }
}

/** Read a File-API file as text (works for the file input and a dropped file). */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("could not read file"));
    reader.readAsText(file);
  });
}
