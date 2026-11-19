// Shared helpers: resolve deps from the ui-diff tools dir, parse simple --flag args,
// and the PNG / changed-region helpers used by diff.cjs and compare.cjs.
const fs = require('fs');
const path = require('path');
const os = require('os');

const TOOLS_DIR =
  process.env.UI_DIFF_HOME ||
  path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ui-diff');

function need(name) {
  try {
    return require(require.resolve(name, { paths: [TOOLS_DIR] }));
  } catch (e) {
    console.error(`Missing dependency "${name}". Run scripts/setup.sh first.`);
    process.exit(2);
  }
}

// What the base re-check (run.sh, diff.cjs --recheck) left out of a page, or ''.
function noiseNote(i) {
  const u = i.unstable;
  if (!u) return '';
  if (u.sizeChanged) return 'base rendered at a different size on a second load, so some of this may be noise';
  return u.ignored ? `${u.ignored.toLocaleString('en-US')} px that also differ between two loads of base were ignored` : '';
}

function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

// "/settings/profile?tab=1" -> "settings-profile-tab-1", "/" -> "home"
function slug(route) {
  const s = route.replace(/^https?:\/\/[^/]+/, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  return s || 'home';
}

// --- PNG helpers (pngjs is loaded lazily so non-image scripts don't need it) ---------
const PNG = () => need('pngjs').PNG;
const readPng = (p) => PNG().sync.read(fs.readFileSync(p));
const writePng = (p, png) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, PNG().sync.write(png));
};
const blank = (w, h) => {
  const out = new (PNG())({ width: w, height: h });
  out.data.fill(255);
  return out;
};

// Place img on a w×h canvas (top-left), filling the rest with opaque white, so images
// of different sizes can still be compared; the padding shows up as change.
function padTo(img, w, h) {
  if (img.width === w && img.height === h) return img;
  const out = blank(w, h);
  PNG().bitblt(img, out, 0, 0, Math.min(img.width, w), Math.min(img.height, h), 0, 0);
  return out;
}

function crop(img, { x, y, w, h }) {
  const out = new (PNG())({ width: w, height: h });
  PNG().bitblt(img, out, x, y, w, h, 0, 0);
  return out;
}

// Group diff pixels (pure red in pixelmatch output) into rectangular regions.
//   grid      px; diff pixels are clustered on this grid to find separate regions
//   pad       px of context around each region
//   reach     cells of gap allowed between pixels of one region (nearby edits merge)
//   minCell   diff pixels a cell needs to count (raise it to ignore scattered AA noise)
//   max       regions kept (largest first); the rest are counted in `omitted`
function findRegions(diff, { grid = 24, pad = 32, reach = 2, minCell = 1, max = 6 } = {}) {
  const gw = Math.ceil(diff.width / grid);
  const gh = Math.ceil(diff.height / grid);
  const counts = new Uint32Array(gw * gh);
  for (let y = 0; y < diff.height; y++) {
    for (let x = 0; x < diff.width; x++) {
      const i = (y * diff.width + x) * 4;
      if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) {
        counts[Math.floor(y / grid) * gw + Math.floor(x / grid)]++;
      }
    }
  }
  const cells = counts.map((n) => (n >= minCell ? 1 : 0));
  // Connected components over the grid.
  const seen = new Uint8Array(gw * gh);
  const boxes = [];
  for (let c = 0; c < cells.length; c++) {
    if (!cells[c] || seen[c]) continue;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
    let count = 0;
    let pixels = 0;
    const stack = [c];
    seen[c] = 1;
    while (stack.length) {
      const k = stack.pop();
      const cx = k % gw;
      const cy = (k - cx) / gw;
      x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
      count++;
      pixels += counts[k];
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const n = ny * gw + nx;
          if (cells[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
        }
      }
    }
    const x = Math.max(0, x0 * grid - pad);
    const y = Math.max(0, y0 * grid - pad);
    boxes.push({
      x, y,
      w: Math.min(diff.width, (x1 + 1) * grid + pad) - x,
      h: Math.min(diff.height, (y1 + 1) * grid + pad) - y,
      cells: count,
      pixels,
    });
  }
  boxes.sort((a, b) => b.cells - a.cells);
  const kept = boxes.slice(0, max).sort((a, b) => a.y - b.y || a.x - b.x);
  return { kept, omitted: boxes.length - kept.length };
}

// --- Animated PNG (APNG) ---------------------------------------------------------------
// A tiny encoder (zlib + chunk writing, no dependency) for the before ⇄ after flips in PR
// comments. APNG is a .png: browsers and GitHub animate it, other viewers show frame 1.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const u32s = (...v) => {
  const b = Buffer.alloc(v.length * 4);
  v.forEach((x, i) => b.writeUInt32BE(x, i * 4));
  return b;
};
function pngChunk(type, data) {
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  return Buffer.concat([u32s(data.length), td, u32s(crc32(td))]);
}

// RGBA pixels -> zlib'd scanlines, with the cheapest filter per row (screenshots compress
// far better with Sub/Up/Paeth than unfiltered).
function deflateRgba({ width: w, height: h, data }) {
  const stride = w * 4;
  const out = Buffer.alloc((stride + 1) * h);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < h; y++) {
    const r = y * stride, q = r - stride;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    for (let i = 0; i < stride; i++) {
      const v = data[r + i], a = i >= 4 ? data[r + i - 4] : 0, b = y ? data[q + i] : 0, c = y && i >= 4 ? data[q + i - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const d0 = v, d1 = (v - a) & 255, d2 = (v - b) & 255, d3 = (v - ((a + b) >> 1)) & 255;
      const d4 = (v - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      cand[0][i] = d0; cand[1][i] = d1; cand[2][i] = d2; cand[3][i] = d3; cand[4][i] = d4;
      s0 += d0 < 128 ? d0 : 256 - d0; s1 += d1 < 128 ? d1 : 256 - d1; s2 += d2 < 128 ? d2 : 256 - d2;
      s3 += d3 < 128 ? d3 : 256 - d3; s4 += d4 < 128 ? d4 : 256 - d4;
    }
    const sums = [s0, s1, s2, s3, s4];
    const best = sums.indexOf(Math.min(...sums));
    out[y * (stride + 1)] = best;
    cand[best].copy(out, y * (stride + 1) + 1);
  }
  return require('zlib').deflateSync(out, { level: 9 });
}

// What changed from prev to img: the bounding box, with unchanged pixels transparent (it's
// drawn over the previous frame), so a later frame only stores what's different.
function delta(prev, img) {
  const { width: w, height: h } = img;
  let [x0, y0, x1, y1] = [w, h, -1, -1];
  const same = (i) => img.data.readUInt32BE(i) === prev.data.readUInt32BE(i);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!same((y * w + x) * 4)) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  if (x1 < 0) [x0, y0, x1, y1] = [0, 0, 0, 0]; // identical: one transparent pixel
  const out = crop(img, { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    if (same(((y + y0) * w + x + x0) * 4)) out.data.writeUInt32BE(0, (y * out.width + x) * 4);
  }
  return { img: out, x: x0, y: y0 };
}

// frames: [{ img, ms }], all the same size; plays 0 = loop forever. Frame 1 is the plain PNG
// image (what non-APNG viewers show); later frames are deltas blended over the previous one.
function encodeApng(frames, { plays = 0 } = {}) {
  const { width: w, height: h } = frames[0].img;
  const parts = [
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', Buffer.concat([u32s(w, h), Buffer.from([8, 6, 0, 0, 0])])), // 8-bit RGBA
    pngChunk('acTL', u32s(frames.length, plays)),
  ];
  let seq = 0;
  frames.forEach(({ img, ms }, i) => {
    const f = i ? delta(frames[i - 1].img, img) : { img, x: 0, y: 0 };
    // fcTL: seq, size, offset, delay ms/1000 (u16 each), dispose none, blend source/over
    const fc = Buffer.concat([u32s(seq++, f.img.width, f.img.height, f.x, f.y), Buffer.from([ms >> 8, ms & 255, 1000 >> 8, 1000 & 255, 0, i ? 1 : 0])]);
    parts.push(pngChunk('fcTL', fc));
    const z = deflateRgba(f.img);
    parts.push(i === 0 ? pngChunk('IDAT', z) : pngChunk('fdAT', Buffer.concat([u32s(seq++), z])));
  });
  parts.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// Box-filter downscale by s (< 1).
function downscale(img, s) {
  const w = Math.max(1, Math.round(img.width * s));
  const h = Math.max(1, Math.round(img.height * s));
  const out = new (PNG())({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * img.height) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * img.width) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / w));
      const n = (y1 - y0) * (x1 - x0);
      for (let k = 0; k < 4; k++) {
        let acc = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) acc += img.data[(yy * img.width + xx) * 4 + k];
        out.data[(y * w + x) * 4 + k] = Math.round(acc / n);
      }
    }
  }
  return out;
}

// 5×7 bitmap glyphs for the frame labels.
const GLYPHS = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
};
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function fillRect(img, x0, y0, w, h, c) {
  for (let y = y0; y < Math.min(img.height, y0 + h); y++) {
    for (let x = x0; x < Math.min(img.width, x0 + w); x++) {
      const i = (y * img.width + x) * 4;
      [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]] = [...c, 255];
    }
  }
}
// img below a coloured bar labelled with text.
function withBar(img, text, bg, fg) {
  const scale = img.width >= 120 ? 2 : 1;
  const bar = 7 * scale + 8;
  const out = blank(img.width, img.height + bar);
  PNG().bitblt(img, out, 0, 0, img.width, img.height, 0, bar);
  fillRect(out, 0, 0, img.width, bar, rgb(bg));
  let x = 6;
  for (const ch of text) {
    GLYPHS[ch].forEach((row, gy) => [...row].forEach((p, gx) => {
      if (p === '#') fillRect(out, x + gx * scale, 4 + gy * scale, scale, scale, rgb(fg));
    }));
    x += 6 * scale;
  }
  return out;
}

// Looping before ⇄ after APNG of two crops: grey "BEFORE" bar, then violet "AFTER" bar,
// ms each. Padded to one size (like padTo) and scaled down to fit maxWidth/maxHeight and,
// for busy crops, maxBytes (but never below half that size or 360px wide; legible wins).
// bars: { before, after } images to use instead of the built-in labels (annotate.cjs renders
// them with a tag and a note), made at flipWidth() wide; scaled along with the crops.
function flipScale(before, after, { maxWidth = 880, maxHeight = 1000 } = {}) {
  const w = Math.max(before.width, after.width);
  const h = Math.max(before.height, after.height);
  return { w, h, s: Math.min(1, maxWidth / w, maxHeight / h) };
}
function flipWidth(before, after, opts) {
  const { w, s } = flipScale(before, after, opts);
  return Math.max(1, Math.round(w * s));
}
function stack(bar, img) {
  const out = blank(img.width, img.height + bar.height);
  PNG().bitblt(bar, out, 0, 0, Math.min(bar.width, img.width), bar.height, 0, 0);
  PNG().bitblt(img, out, 0, 0, img.width, img.height, 0, bar.height);
  return out;
}
function flipApng(before, after, { ms = 1200, maxWidth = 880, maxHeight = 1000, maxBytes = 300e3, bars = null } = {}) {
  const { w, h, s: s0 } = flipScale(before, after, { maxWidth, maxHeight });
  const b = padTo(before, w, h);
  const a = padTo(after, w, h);
  let s = s0;
  const minS = Math.max(s / 2, Math.min(s, 360 / w));
  for (;;) {
    const fb = s < 1 ? downscale(b, s) : b;
    const fa = s < 1 ? downscale(a, s) : a;
    const bar = (side) => {
      const img = bars[side];
      const scaled = s < s0 ? downscale(img, s / s0) : img;
      return padTo(scaled, fb.width, scaled.height);
    };
    const buf = encodeApng(bars ? [
      { img: stack(bar('before'), fb), ms },
      { img: stack(bar('after'), fa), ms },
    ] : [
      { img: withBar(fb, 'BEFORE', '#e5e7eb', '#374151'), ms },
      { img: withBar(fa, 'AFTER', '#7c3aed', '#ffffff'), ms },
    ]);
    if (buf.length <= maxBytes || s <= minS) return buf;
    s = Math.max(minS, s * 0.75);
  }
}

module.exports = { noiseNote, TOOLS_DIR, need, args, slug, readPng, writePng, blank, padTo, crop, findRegions, crc32, encodeApng, flipApng, flipWidth };
