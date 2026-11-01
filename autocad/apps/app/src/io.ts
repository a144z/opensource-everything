import type { DocumentState, PlotOptions } from "@apexus/cad";
import {
  PAPER_SIZES,
  deserializeProjectText,
  drawingBounds,
  plotSvg,
  readDxf,
  serializeProjectJson,
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

/** Plot options the viewer and the export share, so the SVG is the preview. */
export function plotOptions(app: AppState, sheet: { size: keyof typeof PAPER_SIZES; scale: number; margin?: number }): PlotOptions | null {
  const window = drawingBounds(app.doc);
  if (!window) return null;
  const paper = PAPER_SIZES[sheet.size] ?? PAPER_SIZES["A4"]!;
  return { scale: 1 / sheet.scale, paper, window, margin: sheet.margin ?? 10 };
}

export async function plotDrawing(app: AppState, name = "plot.svg", sheet = { size: "A4" as const, scale: 50 }): Promise<string> {
  const opts = plotOptions(app, sheet);
  if (!opts) return "Nothing to plot: the drawing is empty";
  await files.save(name, plotSvg(app.doc, opts), "image/svg+xml");
  return `Plotted ${name} at 1:${sheet.scale}`;
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
