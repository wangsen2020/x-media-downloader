// Minimal dependency-free PNG generator for the extension icons.
// Draws a blue rounded square with a white "download" arrow.
//   node tools/genicons.mjs icons
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function png(size) {
  const w = size;
  const h = size;
  const px = Buffer.alloc(w * h * 4);
  const bg = [29, 155, 240];
  const fg = [255, 255, 255];
  const r = size * 0.22;
  const cx = w / 2;

  const shaftW = size * 0.14;
  const shaftTop = size * 0.24;
  const shaftBot = size * 0.56;
  const headTop = size * 0.46;
  const headBot = size * 0.7;
  const headHalf = size * 0.24;
  const barTop = size * 0.76;
  const barBot = size * 0.84;
  const barHalf = size * 0.26;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let inside = true;
      const rx = Math.min(x, w - 1 - x);
      const ry = Math.min(y, h - 1 - y);
      if (rx < r && ry < r) {
        const dx = r - rx;
        const dy = r - ry;
        if (dx * dx + dy * dy > r * r) inside = false;
      }
      if (!inside) {
        px[i + 3] = 0;
        continue;
      }
      let col = bg;
      const inShaft =
        x >= cx - shaftW / 2 && x <= cx + shaftW / 2 && y >= shaftTop && y <= shaftBot;
      let inHead = false;
      if (y >= headTop && y <= headBot) {
        const t = (y - headTop) / (headBot - headTop);
        if (Math.abs(x - cx) <= headHalf * (1 - t)) inHead = true;
      }
      const inBar = y >= barTop && y <= barBot && Math.abs(x - cx) <= barHalf;
      if (inShaft || inHead || inBar) col = fg;
      px[i] = col[0];
      px[i + 1] = col[1];
      px[i + 2] = col[2];
      px[i + 3] = 255;
    }
  }

  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    px.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = process.argv[2] || 'icons';
for (const s of [16, 48, 128]) {
  writeFileSync(join(outDir, `icon${s}.png`), png(s));
  console.log('wrote', join(outDir, `icon${s}.png`));
}
