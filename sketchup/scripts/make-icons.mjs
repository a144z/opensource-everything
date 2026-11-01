/**
 * Icon generator (task L0-8). No image libraries: draws the FitCheck mark --
 * a solid box inscribed in a dashed fit envelope -- and writes PNGs plus a
 * PNG-format .ico for Windows. Run once; commit the output.
 *
 *   node scripts/make-icons.mjs
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUT = path.resolve("apps/desktop/src-tauri/icons");
mkdirSync(OUT, { recursive: true });

const BG = [34, 38, 43, 255]; // #22262b, matches the viewport
const BOX = [232, 176, 75, 255]; // #e8b04b
const BOX_TOP = [247, 205, 128, 255];
const ENV = [122, 209, 255, 255]; // fit envelope
const FAIL = [232, 102, 75, 255];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  const w = size;
  const h = size;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const c = pixel(x, y, w, h);
      raw[o++] = c[0];
      raw[o++] = c[1];
      raw[o++] = c[2];
      raw[o++] = c[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Point-in-polygon, even-odd. */
function inside(px, py, poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function blur(c, a) {
  // Cheap 1-bit alpha; the OS scales these down anyway.
  return a ? c : BG;
}

const pixel = (x, y, w, h) => {
  const u = x / w;
  const v = y / h;

  // Envelope: dashed rounded-ish rectangle in the upper 2/3.
  const e = { x0: 0.1, y0: 0.08, x1: 0.9, y1: 0.82 };
  const horizontal = u > e.x0 - 0.012 && u < e.x1 + 0.012 && (Math.abs(v - e.y0) < 0.014 || Math.abs(v - e.y1) < 0.014);
  const vertical = v > e.y0 - 0.012 && v < e.y1 + 0.012 && (Math.abs(u - e.x0) < 0.014 || Math.abs(u - e.x1) < 0.014);
  // Dashes run along the edge, not as a checkerboard.
  if (horizontal && ((u * 18) | 0) % 2 === 0) return ENV;
  if (vertical && ((v * 18) | 0) % 2 === 0) return ENV;

  // Isometric box, front face + top face.
  const front = [
    [0.2, 0.58],
    [0.56, 0.71],
    [0.56, 0.92],
    [0.2, 0.79],
  ];
  const top = [
    [0.2, 0.58],
    [0.4, 0.44],
    [0.76, 0.57],
    [0.56, 0.71],
  ];
  if (inside(u, v, front)) return blur(BOX, 1);
  if (inside(u, v, top)) return blur(BOX_TOP, 1);

  // A red tick on the front face: the fit check verdict.
  const du = u - 0.36;
  const dv = v - 0.78;
  if (inside(u, v, front) && Math.abs(du * 0.8 + dv * 0.3) < 0.035 && Math.abs(du) < 0.08) return FAIL;

  return BG;
};

for (const size of [32, 64, 128, 256, 512]) {
  writeFileSync(path.join(OUT, `${size}x${size}.png`), png(size, pixel));
}
writeFileSync(path.join(OUT, "128x128@2x.png"), png(256, pixel));
writeFileSync(path.join(OUT, "icon.png"), png(512, pixel));

// PNG-format .ico: one directory entry per size, payloads are whole PNGs.
const icoSizes = [16, 32, 48, 64, 128, 256];
const images = icoSizes.map((s) => ({ size: s, data: png(s, pixel) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // ICO
header.writeUInt16LE(images.length, 4);
let offset = 6 + images.length * 16;
const entries = [];
for (const { size, data } of images) {
  const e = Buffer.alloc(16);
  e[0] = size >= 256 ? 0 : size;
  e[1] = size >= 256 ? 0 : size;
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += data.length;
  entries.push(e);
}
writeFileSync(
  path.join(OUT, "icon.ico"),
  Buffer.concat([header, ...entries, ...images.map((i) => i.data)]),
);

console.log(`icons written to ${OUT}`);
