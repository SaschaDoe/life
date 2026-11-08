// Generates the app icons (a warm sun) as PNGs – no dependencies.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const SS = 4; // supersampling
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const [pr, pg, pb, pa] = pixel((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
        r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? r / a : 0; raw[o + 1] = a ? g / a : 0; raw[o + 2] = a ? b / a : 0; raw[o + 3] = (a / (SS * SS)) * 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// sun shape in unit coords, scaled by s around center
function sun(x, y, s = 1) {
  const dx = (x - 0.5) / s, dy = (y - 0.5) / s;
  if (Math.hypot(dx, dy) < 0.17) return true;
  for (let i = 0; i < 8; i++) {
    const ang = (i * Math.PI) / 4, cx = Math.cos(ang), cy = Math.sin(ang);
    const t = Math.min(0.34, Math.max(0.25, dx * cx + dy * cy));
    if (Math.hypot(dx - t * cx, dy - t * cy) < 0.036) return true;
  }
  return false;
}
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const A = [245, 120, 50], B = [232, 69, 122];

function icon(x, y, { round, scale }) {
  if (round) { // rounded square with transparent corners
    const r = 0.22, qx = Math.abs(x - 0.5) - (0.5 - r), qy = Math.abs(y - 0.5) - (0.5 - r);
    if (Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) > r) return [0, 0, 0, 0];
  }
  if (sun(x, y, scale)) return [255, 250, 240, 1];
  return [...mix(A, B, (x + y) / 2), 1];
}

const write = (name, buf) => { fs.writeFileSync(path.join(OUT, name), buf); console.log('✓', name); };
write('icon-192.png', png(192, (x, y) => icon(x, y, { round: true, scale: 1 })));
write('icon-512.png', png(512, (x, y) => icon(x, y, { round: true, scale: 1 })));
write('icon-maskable-512.png', png(512, (x, y) => icon(x, y, { round: false, scale: 0.78 })));
write('badge-96.png', png(96, (x, y) => (sun(x, y, 1.3) ? [255, 255, 255, 1] : [0, 0, 0, 0])));
