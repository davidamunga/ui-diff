#!/usr/bin/env node
// Put a tag and a UX note on each before ⇄ after animation: "Flow change" or "Visual only",
// then one line on what changed in that area. Redraws report/zoom/*__flip.png in place.
//
// Usage:
//   node annotate.cjs --report .ui-diff/report [--notes notes.json] [--list] [--no-animate]
//
// Each changed region already has an automatic annotation from stylediff.cjs (region.annotation,
// built from the measured changes: controls added/removed, link targets, reordered actions,
// copy, style). An agent can replace any of them with its own words in a notes file
// (default <report>/notes.json when present):
//
//   {
//     "pricing__desktop__light__r1": { "kind": "flow", "note": "Trial now starts from the Crew card" },
//     "/pricing": "Headline rewritten; cards are rounder",   // every region of a route
//     "*": { "kind": "visual" }                               // every region left
//   }
//
// Keys: a region id (<screenshot name>__r<n>, as --list prints), a route, or "*"; the most
// specific wins. Values: a note string, or { kind?: "flow"|"visual", note? } (missing fields
// keep the automatic ones). A bare string for a route or "*" only reaches that route's visual
// areas, so a page-wide note never hides a flow change; target those by id or with "kind". --list prints the regions and their current annotations as JSON.
// A flow change inside an area too big for a zoom (most of the page) gets its own crop around
// the changed controls (region.zoom.focus). --no-animate: annotations only, no images.
// Updates results.json (region.annotation, with source "agent" or "auto"); comment.cjs and
// viewer.cjs show the same tag and note next to each animation.
const fs = require('fs');
const path = require('path');
const { need, args, readPng, writePng, padTo, crop, flipApng, flipWidth } = require('./lib.cjs');

const a = args();
if (!a.report) {
  console.error('Required: --report <dir>');
  process.exit(1);
}
const resultsPath = path.join(a.report, 'results.json');
const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
const notesPath = a.notes || path.join(a.report, 'notes.json');
let notes = {};
if (fs.existsSync(notesPath)) {
  try { notes = JSON.parse(fs.readFileSync(notesPath, 'utf8')); } catch (e) {
    console.error(`Can't read ${notesPath}: ${e.message}`);
    process.exit(1);
  }
} else if (a.notes) {
  console.error(`No such notes file: ${a.notes}`);
  process.exit(1);
}

for (const [key, v] of Object.entries(notes)) {
  const ok = typeof v === 'string' || (v && typeof v === 'object' && (v.kind === undefined || ['flow', 'visual'].includes(v.kind)) &&
    (v.note === undefined || typeof v.note === 'string'));
  if (!ok) {
    console.error(`notes["${key}"] must be a string or { "kind": "flow"|"visual", "note": "..." } (got ${JSON.stringify(v)})`);
    process.exit(1);
  }
}

const regions = [];
for (const item of results.items) {
  if (item.status !== 'changed') continue;
  (item.regions || []).forEach((r, i) => {
    // No zoom (the area is most of the page) but a flow change inside: animate around it.
    if (!r.zoom && !(r.annotation && r.annotation.kind === 'flow' && r.annotation.focus)) return;
    regions.push({ id: `${item.file.replace(/\.png$/, '')}__r${i + 1}`, item, r });
  });
}

// Automatic annotation (kept as r.annotation.auto once something overrides it), then the
// notes file: "*" < route < region id.
function resolve({ id, item, r }) {
  const auto = (r.annotation && (r.annotation.auto || (r.annotation.source !== 'agent' && r.annotation))) ||
    { kind: (item.flow && item.flow.kind) || 'visual', note: '', source: 'auto' };
  let kind = auto.kind, note = auto.note, agent = false;
  for (const key of ['*', item.route, item.name, id]) {
    if (!key || !(key in notes)) continue;
    const v = notes[key];
    // A bare note for a whole route (or "*") is for its visual areas: it doesn't paper over
    // a specific flow note. Use the region id, or give "kind", to reach those.
    if (typeof v === 'string' && key !== id && kind === 'flow') continue;
    const o = typeof v === 'string' ? { note: v } : v || {};
    if (o.kind) kind = o.kind;
    if (typeof o.note === 'string') note = o.note.replace(/\s+/g, ' ').trim();
    agent = true;
  }
  const { auto: _drop, ...autoPlain } = auto;
  return agent ? { kind, note, source: 'agent', auto: autoPlain } : { ...autoPlain, source: 'auto' };
}

if (a.list) {
  console.log(JSON.stringify(regions.map((x) => ({
    id: x.id, route: x.item.route, viewport: x.item.viewport, scheme: x.item.scheme, ...resolve(x),
  })), null, 2));
  process.exit(0);
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// One bar per frame: side label + tag on the first line, the note under it (up to 2 lines).
function barHtml(side, kind, note, width) {
  const fs = Math.max(12, Math.min(16, Math.round(width / 55)));
  const after = side === 'after';
  const flow = kind === 'flow';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; background: transparent; }
    #bar { width: ${width}px; box-sizing: border-box; padding: ${Math.round(fs * 0.45)}px ${Math.round(fs * 0.6)}px;
      background: ${after ? '#7c3aed' : '#e5e7eb'}; color: ${after ? '#ffffff' : '#374151'};
      font: 500 ${fs}px/1.35 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "DejaVu Sans", sans-serif; }
    .row { display: flex; align-items: center; gap: ${Math.round(fs * 0.5)}px; }
    .side { font-weight: 800; letter-spacing: .08em; font-size: ${fs - 1}px; }
    .tag { font-weight: 700; font-size: ${fs - 2}px; padding: 1px ${Math.round(fs * 0.5)}px; border-radius: 999px; white-space: nowrap;
      ${flow ? 'background: #f59e0b; color: #1f1300;' : `background: ${after ? 'rgba(255,255,255,.22)' : 'rgba(55,65,81,.12)'}; color: inherit;`} }
    .note { margin-top: ${Math.round(fs * 0.25)}px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  </style></head><body><div id="bar"><div class="row"><span class="side">${after ? 'AFTER' : 'BEFORE'}</span>
    <span class="tag">${flow ? 'Flow change' : 'Visual only'}</span></div>${note ? `<div class="note">${esc(note)}</div>` : ''}</div></body></html>`;
}

async function main() {
  if (!regions.length) {
    console.log(JSON.stringify({ annotated: 0 }));
    return;
  }
  const { chromium } = need('playwright');
  const { PNG } = need('pngjs');
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 1000, height: 200 } });
  const render = async (side, kind, note, width) => {
    await page.setViewportSize({ width: Math.max(width, 100), height: 200 });
    await page.setContent(barHtml(side, kind, note, width));
    return PNG.sync.read(await page.locator('#bar').screenshot({ omitBackground: true }));
  };
  let n = 0;
  try {
    for (const x of regions) {
      const ann = resolve(x);
      x.r.annotation = ann;
      if (!x.r.zoom) {
        const f = (ann.auto || ann).focus;
        if (!f || a['no-animate']) continue;
        const id = `zoom/${x.id}`;
        const full = (side) => readPng(path.join(a.report, side, x.item.file));
        const fb = full('before'), fa = full('after');
        const fit = (img) => crop(padTo(img, Math.max(fb.width, fa.width), Math.max(fb.height, fa.height)), { x: f.x, y: f.y, w: f.width, h: f.height });
        x.r.zoom = { before: `${id}__before.png`, after: `${id}__after.png`, flip: `${id}__flip.png`, focus: true };
        writePng(path.join(a.report, x.r.zoom.before), fit(fb));
        writePng(path.join(a.report, x.r.zoom.after), fit(fa));
      }
      if (!x.r.zoom.flip) continue; // animations off: the tag and note still go in the comment
      const before = readPng(path.join(a.report, x.r.zoom.before));
      const after = readPng(path.join(a.report, x.r.zoom.after));
      const w = flipWidth(before, after);
      const bars = { before: await render('before', ann.kind, ann.note, w), after: await render('after', ann.kind, ann.note, w) };
      fs.writeFileSync(path.join(a.report, x.r.zoom.flip), flipApng(before, after, { bars }));
      n++;
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  const flows = regions.filter((x) => x.r.annotation.kind === 'flow').length;
  console.log(JSON.stringify({ annotated: n, flow: flows, visual: regions.length - flows, fromNotes: regions.filter((x) => x.r.annotation.source === 'agent').length }));
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
