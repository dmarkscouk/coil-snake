/* Generates the PWA icon set as PNGs with no third-party deps. */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return buf => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td));
  return Buffer.concat([len, td, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --- tiny painter --------------------------------------------------- */
function makeCanvas(size) {
  const buf = Buffer.alloc(size * size * 4);
  return {
    size, buf,
    fill(r, g, b) {
      for (let i = 0; i < size * size; i++) { buf[i*4]=r; buf[i*4+1]=g; buf[i*4+2]=b; buf[i*4+3]=255; }
    },
    disc(cx, cy, rad, r, g, b, a = 1) {
      const x0 = Math.max(0, Math.floor(cx - rad - 1)), x1 = Math.min(size - 1, Math.ceil(cx + rad + 1));
      const y0 = Math.max(0, Math.floor(cy - rad - 1)), y1 = Math.min(size - 1, Math.ceil(cy + rad + 1));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        let cov = rad + 0.5 - d;
        if (cov <= 0) continue;
        cov = Math.min(1, cov) * a;
        const i = (y * size + x) * 4;
        buf[i]   = buf[i]   + (r - buf[i])   * cov;
        buf[i+1] = buf[i+1] + (g - buf[i+1]) * cov;
        buf[i+2] = buf[i+2] + (b - buf[i+2]) * cov;
        buf[i+3] = Math.max(buf[i+3], 255 * cov);
      }
    },
    /* rounded-rect clip to transparent outside */
    roundClip(radius) {
      const r = radius;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const qx = Math.max(r - (x + 0.5), (x + 0.5) - (size - r));
        const qy = Math.max(r - (y + 0.5), (y + 0.5) - (size - r));
        let d = 0;
        if (qx > 0 && qy > 0) d = Math.hypot(qx, qy) - r;
        else d = Math.max(qx, qy) - r;
        if (d > 0) {
          const i = (y * size + x) * 4;
          buf[i+3] = Math.round(buf[i+3] * Math.max(0, 1 - d));
        }
      }
    },
  };
}

function hsl(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  const f = n => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))));
  };
  return [f(0), f(8), f(4)];
}

function drawIcon(size, inset) {
  const c = makeCanvas(size);
  c.fill(9, 13, 24);
  // faint vignette of stars/food
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    c.disc(x, y, size * 0.006, 120, 140, 200, 0.5);
  }
  const S = size * inset;        // drawable area
  const o = (size - S) / 2;
  const cx = o + S / 2, cy = o + S / 2;

  // a coiled S-curve
  const pts = [];
  const N = 420;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const a = (-0.55 + t * 2.1) * Math.PI;
    const rad = S * (0.40 - t * 0.17);
    pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad * 0.92]);
  }
  const w = S * 0.115;
  // glow
  for (const [x, y] of pts) c.disc(x, y, w * 1.5, ...hsl(140, 90, 55), 0.045);
  // body
  for (const [x, y] of pts) c.disc(x, y, w, ...hsl(142, 70, 42));
  // highlight
  for (const [x, y] of pts) c.disc(x, y, w * 0.46, ...hsl(140, 92, 64));

  // head + eye
  const [hx, hy] = pts[0];
  c.disc(hx, hy, w * 1.06, ...hsl(142, 72, 46));
  c.disc(hx + w * 0.30, hy - w * 0.42, w * 0.34, 253, 253, 255);
  c.disc(hx + w * 0.40, hy - w * 0.44, w * 0.17, 10, 13, 22);

  // food pellets
  c.disc(o + S * 0.17, o + S * 0.80, S * 0.045, ...hsl(42, 95, 62));
  c.disc(o + S * 0.84, o + S * 0.22, S * 0.038, ...hsl(200, 95, 66));
  c.disc(o + S * 0.80, o + S * 0.74, S * 0.030, ...hsl(330, 92, 68));
  return c;
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

// standard icons: rounded corners, content fairly large
for (const size of [180, 192, 512]) {
  const c = drawIcon(size, 0.80);
  c.roundClip(size * 0.22);
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png(size, size, c.buf));
}
// maskable: full bleed, content inside the 60% safe zone
{
  const size = 512;
  const c = drawIcon(size, 0.58);
  fs.writeFileSync(path.join(outDir, 'icon-maskable-512.png'), png(size, size, c.buf));
}
console.log('icons written');
