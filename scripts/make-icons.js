// Generates the app icons (PNG sizes, ICO, SVG, and .icns on macOS) with no dependencies.
// Usage: node scripts/make-icons.js   (on macOS it also builds assets/AppIcon.icns via iconutil)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const OUT = path.join(__dirname, '..', 'assets');
const BLUE = [12, 102, 228];
fs.mkdirSync(OUT, { recursive: true });

// --- PNG encoder ---
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// --- shapes (signed distance, in pixels) ---
const sdRoundRect = (x, y, c, h, r) => { const qx = Math.abs(x - c) - (h - r); const qy = Math.abs(y - c) - (h - r); return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; };
const sdSegment = (px, py, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay; const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))); return Math.hypot(px - ax - t * dx, py - ay - t * dy); };
const cover = (d) => Math.max(0, Math.min(1, 0.5 - d)); // 1px antialias

// check mark in a 16-unit grid (same path as the favicon.svg / UI logo)
const CHECK = [[3, 8.5], [6, 11.5], [13, 4.5]];

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const u = size / 16;
  const c = size / 2;
  const half = size / 2;
  const radius = size * 0.22;
  const stroke = 1.9 * u / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      const sd = sdRoundRect(px, py, c, half, radius);
      const chk = Math.min(sdSegment(px, py, CHECK[0][0] * u, CHECK[0][1] * u, CHECK[1][0] * u, CHECK[1][1] * u), sdSegment(px, py, CHECK[1][0] * u, CHECK[1][1] * u, CHECK[2][0] * u, CHECK[2][1] * u)) - stroke;
      const bg = cover(sd), fg = cover(chk);
      const a = bg;
      const r = BLUE[0] * (1 - fg) + 255 * fg, g = BLUE[1] * (1 - fg) + 255 * fg, b = BLUE[2] * (1 - fg) + 255 * fg;
      const o = (y * size + x) * 4;
      buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

// supersample 3x for smoother edges on small sizes
const icon = (size) => { const big = render(size * 3); const out = Buffer.alloc(size * size * 4); for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { let r = 0, g = 0, b = 0, a = 0; for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) { const o = ((y * 3 + j) * size * 3 + x * 3 + i) * 4; const al = big[o + 3]; r += big[o] * al; g += big[o + 1] * al; b += big[o + 2] * al; a += al; } const o = (y * size + x) * 4; if (a) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; } out[o + 3] = a / 9; } return out; };

const sizes = [16, 32, 48, 64, 128, 180, 256, 512, 1024];
const pngs = {};
for (const s of sizes) { pngs[s] = png(s, icon(s)); fs.writeFileSync(path.join(OUT, `icon-${s}.png`), pngs[s]); }
fs.copyFileSync(path.join(OUT, 'icon-180.png'), path.join(OUT, 'apple-touch-icon.png'));

// ICO (PNG-compressed entries)
const icoSizes = [16, 32, 48, 256];
const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(icoSizes.length, 4);
let offset = 6 + 16 * icoSizes.length;
const dir = icoSizes.map((s) => { const e = Buffer.alloc(16); e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(pngs[s].length, 8); e.writeUInt32LE(offset, 12); offset += pngs[s].length; return e; });
fs.writeFileSync(path.join(OUT, 'icon.ico'), Buffer.concat([head, ...dir, ...icoSizes.map((s) => pngs[s])]));

// SVG (vector favicon)
fs.writeFileSync(path.join(OUT, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0c66e4"/><path d="M6 17l6 6 14-14" fill="none" stroke="#fff" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/></svg>\n`);

// macOS .icns
if (process.platform === 'darwin') {
  const set = path.join(OUT, 'AppIcon.iconset');
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set);
  const map = { 'icon_16x16.png': 16, 'icon_16x16@2x.png': 32, 'icon_32x32.png': 32, 'icon_32x32@2x.png': 64, 'icon_128x128.png': 128, 'icon_128x128@2x.png': 256, 'icon_256x256.png': 256, 'icon_256x256@2x.png': 512, 'icon_512x512.png': 512, 'icon_512x512@2x.png': 1024 };
  for (const [name, s] of Object.entries(map)) fs.writeFileSync(path.join(set, name), pngs[s]);
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(OUT, 'AppIcon.icns')]);
  fs.rmSync(set, { recursive: true, force: true });
}
console.log('icons written to', OUT);
