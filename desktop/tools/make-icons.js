"use strict";
/* ============================================================================
   EduSphere desktop — icon generator (dependency free)
   ----------------------------------------------------------------------------
   Windows needs `.ico`, macOS needs `.icns`, Linux wants a folder of PNGs, and
   Electron wants a plain PNG for the window/tray. Rather than committing
   binary blobs nobody can regenerate, this script DRAWS the mark itself and
   encodes every format with Node's own zlib — no ImageMagick, no sharp, no
   network.

   Run:  node tools/make-icons.js      (from desktop/)
   Writes:
     assets/icon.png, assets/icon-128.png, assets/icon.ico
     assets/tray.png, assets/trayTemplate.png, assets/trayTemplate@2x.png
     build/icon.png, build/icon.ico, build/icon.icns
     build/icons/<size>x<size>.png   (Linux hicolor theme)
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const ASSETS = path.join(ROOT, "assets");
const BUILD = path.join(ROOT, "build");

/* ------------------------------ PNG encoder ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** RGBA pixel buffer → PNG file buffer. */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/* -------------------------------- drawing -------------------------------- */

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function roundedRectInside(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * The mark: a deep-violet rounded square with a graduation cap over an open
 * book. Deliberately built from bold primitives so it stays legible at 16 px.
 * @returns {Buffer} 1024×1024 RGBA
 */
function drawMaster(size = 1024) {
  const rgba = Buffer.alloc(size * size * 4);
  const top = [88, 46, 152];
  const bottom = [40, 18, 74];
  const gold = [242, 193, 78];
  const goldDark = [206, 158, 44];
  const paper = [252, 250, 255];

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = px / size;
      const y = py / size;
      let colour = null;

      // Background badge.
      if (roundedRectInside(x, y, 0.045, 0.045, 0.955, 0.955, 0.2)) {
        colour = mix(top, bottom, Math.min(1, Math.max(0, (y - 0.045) / 0.91)));
      }
      if (colour) {
        // Soft highlight across the top-left corner.
        const glow = Math.max(0, 1 - Math.hypot(x - 0.28, y - 0.22) / 0.62);
        if (glow > 0) colour = mix(colour, [255, 255, 255], glow * 0.12);
      }

      // Graduation cap: a flat diamond plus its mortarboard base.
      const diamond = Math.abs(x - 0.5) / 0.3 + Math.abs(y - 0.315) / 0.125;
      if (diamond <= 1) colour = gold;
      if (y >= 0.395 && y <= 0.448 && Math.abs(x - 0.5) <= 0.175 - (y - 0.395) * 0.35) colour = goldDark;

      // Open book: two pages with a spine gap.
      if (roundedRectInside(x, y, 0.235, 0.545, 0.482, 0.775, 0.035)) colour = paper;
      if (roundedRectInside(x, y, 0.518, 0.545, 0.765, 0.775, 0.035)) colour = paper;
      if (y >= 0.545 && y <= 0.775 && x > 0.487 && x < 0.513) colour = gold;

      // Three "text" lines on each page for a card/ledger feel.
      if (y >= 0.60 && y <= 0.628 && ((x > 0.275 && x < 0.445) || (x > 0.555 && x < 0.725))) colour = [186, 168, 214];
      if (y >= 0.665 && y <= 0.693 && ((x > 0.275 && x < 0.415) || (x > 0.555 && x < 0.695))) colour = [206, 191, 228];
      if (y >= 0.73 && y <= 0.758 && ((x > 0.275 && x < 0.435) || (x > 0.555 && x < 0.715))) colour = [222, 211, 238];

      const i = (py * size + px) * 4;
      if (!colour) {
        rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = 0;
      } else {
        rgba[i] = colour[0];
        rgba[i + 1] = colour[1];
        rgba[i + 2] = colour[2];
        rgba[i + 3] = 255;
      }
    }
  }
  return rgba;
}

/** Box-filter downsample (keeps small sizes crisp and free of jaggies). */
function resize(source, sourceSize, targetSize) {
  const out = Buffer.alloc(targetSize * targetSize * 4);
  const ratio = sourceSize / targetSize;
  for (let y = 0; y < targetSize; y++) {
    for (let x = 0; x < targetSize; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const x0 = Math.floor(x * ratio);
      const y0 = Math.floor(y * ratio);
      const x1 = Math.min(sourceSize, Math.ceil((x + 1) * ratio));
      const y1 = Math.min(sourceSize, Math.ceil((y + 1) * ratio));
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * sourceSize + sx) * 4;
          const alpha = source[i + 3] / 255;
          r += source[i] * alpha;
          g += source[i + 1] * alpha;
          b += source[i + 2] * alpha;
          a += source[i + 3];
          n += 1;
        }
      }
      const o = (y * targetSize + x) * 4;
      const alphaAvg = n ? a / n : 0;
      const weight = n ? (alphaAvg / 255) : 0;
      out[o] = weight ? Math.round(r / n / weight) : 0;
      out[o + 1] = weight ? Math.round(g / n / weight) : 0;
      out[o + 2] = weight ? Math.round(b / n / weight) : 0;
      out[o + 3] = Math.round(alphaAvg);
    }
  }
  return out;
}

/** Monochrome tray glyph (macOS template image: black + alpha only). */
function drawTrayGlyph(size = 44) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = px / size;
      const y = py / size;
      let alpha = 0;
      const diamond = Math.abs(x - 0.5) / 0.42 + Math.abs(y - 0.34) / 0.19;
      if (diamond <= 1) alpha = 255;
      if (y >= 0.46 && y <= 0.53 && Math.abs(x - 0.5) <= 0.24) alpha = 255;
      if (roundedRectInside(x, y, 0.2, 0.6, 0.47, 0.8, 0.05)) alpha = 255;
      if (roundedRectInside(x, y, 0.53, 0.6, 0.8, 0.8, 0.05)) alpha = 255;
      const i = (py * size + px) * 4;
      rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = alpha;
    }
  }
  return rgba;
}

/* ------------------------------- containers ------------------------------ */

/** Windows .ico with PNG-compressed entries (Vista+). */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const directory = [];
  const blobs = [];
  let offset = 6 + entries.length * 16;
  for (const entry of entries) {
    const dir = Buffer.alloc(16);
    dir[0] = entry.size >= 256 ? 0 : entry.size;
    dir[1] = entry.size >= 256 ? 0 : entry.size;
    dir[2] = 0; // palette
    dir[3] = 0;
    dir.writeUInt16LE(1, 4);   // colour planes
    dir.writeUInt16LE(32, 6);  // bits per pixel
    dir.writeUInt32LE(entry.png.length, 8);
    dir.writeUInt32LE(offset, 12);
    directory.push(dir);
    blobs.push(entry.png);
    offset += entry.png.length;
  }
  return Buffer.concat([header, ...directory, ...blobs]);
}

/** macOS .icns with PNG entries (ic07…ic14). */
function buildIcns(entries) {
  const TYPES = { 16: "icp4", 32: "icp5", 64: "icp6", 128: "ic07", 256: "ic08", 512: "ic09", 1024: "ic10" };
  const chunks = [];
  for (const entry of entries) {
    const type = TYPES[entry.size];
    if (!type) continue;
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, "ascii");
    head.writeUInt32BE(entry.png.length + 8, 4);
    chunks.push(head, entry.png);
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write("icns", 0, 4, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/* --------------------------------- main --------------------------------- */

function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  fs.mkdirSync(path.join(BUILD, "icons"), { recursive: true });

  const MASTER = 1024;
  const master = drawMaster(MASTER);
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  const rendered = new Map();
  for (const size of sizes) {
    const rgba = size === MASTER ? master : resize(master, MASTER, size);
    rendered.set(size, { rgba, png: encodePng(size, size, rgba) });
  }

  // Electron window icon + macOS/Linux "source" icon.
  fs.writeFileSync(path.join(ASSETS, "icon.png"), rendered.get(512).png);
  fs.writeFileSync(path.join(ASSETS, "icon-128.png"), rendered.get(128).png);
  fs.writeFileSync(path.join(BUILD, "icon.png"), rendered.get(1024).png);
  fs.writeFileSync(path.join(ASSETS, "icon.ico"), buildIco([16, 24, 32, 48, 64, 128, 256].map((s) => ({ size: s, png: rendered.get(s).png }))));
  fs.writeFileSync(path.join(BUILD, "icon.ico"), buildIco([16, 24, 32, 48, 64, 128, 256].map((s) => ({ size: s, png: rendered.get(s).png }))));
  fs.writeFileSync(path.join(BUILD, "icon.icns"), buildIcns([16, 32, 64, 128, 256, 512, 1024].map((s) => ({ size: s, png: rendered.get(s).png }))));

  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    fs.writeFileSync(path.join(BUILD, "icons", size + "x" + size + ".png"), rendered.get(size).png);
  }

  // Tray: colour glyph for Windows/Linux, template (monochrome) for macOS.
  const traySize = 32;
  const tray = resize(master, MASTER, traySize);
  fs.writeFileSync(path.join(ASSETS, "tray.png"), encodePng(traySize, traySize, tray));
  fs.writeFileSync(path.join(ASSETS, "trayTemplate.png"), encodePng(22, 22, drawTrayGlyph(22)));
  fs.writeFileSync(path.join(ASSETS, "trayTemplate@2x.png"), encodePng(44, 44, drawTrayGlyph(44)));

  const written = [
    "assets/icon.png", "assets/icon-128.png", "assets/icon.ico",
    "assets/tray.png", "assets/trayTemplate.png", "assets/trayTemplate@2x.png",
    "build/icon.png", "build/icon.ico", "build/icon.icns",
    "build/icons/*.png (9 sizes)",
  ];
  console.log("EduSphere icons written:\n  " + written.join("\n  "));
}

if (require.main === module) main();

module.exports = { buildIcns, buildIco, drawMaster, encodePng, resize };
