#!/usr/bin/env node
// Write a local before/after review page for a run.sh report.
//
// Usage: node viewer.cjs --report .ui-diff/report [--summary <file>] [--out <file>]
//
// Writes report/index.html (or --out): one self-contained file, inline CSS/JS, images by
// relative path. Per changed screenshot: drag slider, side by side, diff overlay, zoomed
// regions and measured changes; then new/removed pages, failures and unchanged pages.
// --summary defaults to report/summary.md, included at the top when it exists.
// Rerun after writing summary.md to include it.
const fs = require('fs');
const path = require('path');
const { args, noiseNote } = require('./lib.cjs');

const a = args();
if (!a.report) {
  console.error('Required: --report <dir>');
  process.exit(1);
}
const read = (f) => JSON.parse(fs.readFileSync(path.join(a.report, f), 'utf8'));
const { summary, items } = read('results.json');
const run = fs.existsSync(path.join(a.report, 'run.json')) ? read('run.json') : null;
const summaryPath = a.summary || path.join(a.report, 'summary.md');
const outPath = a.out || path.join(a.report, 'index.html');
// Image paths are relative to the report dir; adjust if the page is written elsewhere.
const prefix = path.relative(path.dirname(path.resolve(outPath)), path.resolve(a.report));
const src = (rel) => esc(prefix ? `${prefix}/${rel}` : rel);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const label = (i) => [i.viewport, i.scheme && i.scheme !== 'light' ? i.scheme : null].filter(Boolean).join(' · ');
const title = (i) => `${i.route || i.name} — ${label(i)}`;
const id = (i) => 'i-' + i.file.replace(/\.png$/, '').replace(/[^a-zA-Z0-9_-]/g, '-');
// Phones are captured wider than they display; keep them phone-sized on screen.
const phone = (i) => /mobile|phone|iphone|pixel|galaxy|android/i.test(i.viewport || '');

// Inline markdown: `code`, **bold**, *em*, [text](url). Input must already be escaped.
const inline = (s) => s
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
  .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');

// Enough markdown for summary.md: headings, lists, paragraphs.
function markdown(md) {
  const out = [];
  let list = false;
  const close = () => { if (list) { out.push('</ul>'); list = false; } };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,4})\s+(.*)/);
    const li = line.match(/^\s*[-*]\s+(.*)/);
    if (!line.trim()) close();
    else if (h) { close(); out.push(`<h${h[1].length + 2}>${inline(esc(h[2]))}</h${h[1].length + 2}>`); }
    else if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(esc(li[1]))}</li>`); }
    else { close(); out.push(`<p>${inline(esc(line))}</p>`); }
  }
  close();
  return out.join('\n');
}

// Width/height from the PNG header, so lazy-loaded images reserve their space.
function size(rel) {
  try {
    const fd = fs.openSync(path.join(a.report, rel), 'r');
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 16);
    fs.closeSync(fd);
    return ` width="${buf.readUInt32BE(0)}" height="${buf.readUInt32BE(4)}"`;
  } catch { return ''; }
}
const img = (rel, alt, cls = '') => `<img src="${src(rel)}" alt="${esc(alt)}"${size(rel)}${cls ? ` class="${cls}"` : ''} loading="lazy">`;
const warnings = (i) => (i.warnings || []).map((w) => `<p class="warn">⚠️ ${esc(w)}</p>`).join('');
// Possible bugs new on head (stylediff.cjs), with their zoom crops.
const problems = (i) => {
  const list = (i.issues && i.issues.new) || [];
  if (!list.length) return '';
  const more = i.issues.omitted ? `<li>…and ${i.issues.omitted} more (see measured.md)</li>` : '';
  return `<div class="problems"><h3>⚠️ Possible problems <span class="muted">new in this PR · heuristics, worth a check</span></h3><ul>${list.map((p) =>
    `<li>${inline(esc(p.line))}${p.zoom ? img(p.zoom, p.type, 'pzoom') : ''}</li>`).join('')}${more}</ul></div>`;
};
const measured = (i) => {
  const lines = (i.measured && i.measured.lines) || [];
  if (!lines.length) return '';
  return `<h3>Measured changes</h3><ul class="measured">${lines.map((l) => `<li${l.startsWith('⚠️') ? ' class="warn"' : ''}>${inline(esc(l))}</li>`).join('')}</ul>`;
};

function changed(i) {
  const size = i.sizeChanged ? ` · height ${i.before.height} → ${i.after.height}px` : '';
  const zoomed = (i.regions || []).filter((r) => r.zoom);
  const zooms = zoomed.length
    ? `<h3>Changed areas</h3><div class="zooms">${zoomed.map((r, n) => `
      <figure class="zoom"><figcaption>Area ${n + 1}${r.annotation ? ` · <strong>${r.annotation.kind === 'flow' ? '🔀 Flow change' : 'Visual only'}</strong>${r.annotation.note ? ` · ${esc(r.annotation.note)}` : ''}` : ''} <span>${r.width}×${r.height} at ${r.x},${r.y}</span></figcaption>
        <div class="trio${r.zoom.flip ? ' four' : ''}">${['before', 'after', 'diff', 'flip'].filter((s) => r.zoom[s]).map((s) => `<div><span class="cap">${s === 'flip' ? 'animated' : s}</span>${img(r.zoom[s], `${s === 'flip' ? 'before, then after (animated)' : s}, area ${n + 1}`)}</div>`).join('')}</div>
      </figure>`).join('')}</div>`
    : '';
  const more = i.regionsOmitted ? `<p class="muted">+${i.regionsOmitted} more changed area${i.regionsOmitted > 1 ? 's' : ''}; see the full page.</p>` : '';
  return `
    <p class="muted">${i.percent}% of pixels changed${size}${noiseNote(i) ? ` · ${esc(noiseNote(i))}` : ''}</p>${warnings(i)}${problems(i)}
    <div class="controls" role="group" aria-label="View">
      <button type="button" data-mode="slider" aria-pressed="true">Slider</button>
      <button type="button" data-mode="side" aria-pressed="false">Side by side</button>
      <label><input type="checkbox" class="diff-toggle"> Diff overlay</label>
    </div>
    <div class="view${phone(i) ? ' phone' : ''}" data-mode="slider">
      <div class="stage" style="--pos:50%">
        <div class="layer after">${img(`after/${i.file}`, 'after')}${img(`diff/${i.file}`, 'diff', 'diff')}</div>
        <div class="layer before">${img(`before/${i.file}`, 'before')}</div>
        <div class="handle" role="slider" tabindex="0" aria-label="Before/after split" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"></div>
        <span class="tag l">before</span><span class="tag r">after</span>
      </div>
      <div class="side">
        <figure><figcaption>Before</figcaption>${img(`before/${i.file}`, 'before')}</figure>
        <figure><figcaption>After</figcaption>${img(`after/${i.file}`, 'after')}</figure>
        <figure class="diffpane"><figcaption>Diff</figcaption>${img(`diff/${i.file}`, 'diff')}</figure>
      </div>
    </div>
    ${zooms}${more}${measured(i)}`;
}

function single(i, side, word) {
  return `<p class="muted">${word}</p>${warnings(i)}${problems(i)}
    <div class="view single${phone(i) ? ' phone' : ''}"><figure>${img(`${side}/${i.file}`, side)}</figure></div>${measured(i)}`;
}

const kinds = [
  ['changed', '', changed],
  ['added', '🆕 ', (i) => single(i, 'after', 'New page: only exists on head.')],
  ['removed', '🗑️ ', (i) => single(i, 'before', 'Removed: only exists on base.')],
  ['unchanged', '⚠️ ', (i) => `<p class="muted">No visual change.</p>${problems(i)}`],
];
// Group a page's viewports and schemes together, light before dark.
const order = (x, y) => [x.route || x.name, y.route || y.name, x.viewport, y.viewport, x.scheme === 'light' ? '' : x.scheme || '', y.scheme === 'light' ? '' : y.scheme || '']
  .reduce((r, v, k, l) => r || (k % 2 ? 0 : String(v).localeCompare(String(l[k + 1]))), 0);
items.sort(order);
// Unchanged pages only get a tab when a check found a new problem there.
const nav = kinds.flatMap(([k, mark, render]) => items.filter((i) => i.status === k && (k !== 'unchanged' || (i.issues && i.issues.new.length))).map((i) => ({ i, mark, render })));
const problemCount = items.reduce((n, i) => n + ((i.issues && i.issues.new.length) || 0), 0);

const stats = [
  summary.changed && `<strong>${summary.changed} changed</strong>`,
  summary.added && `${summary.added} new`,
  summary.removed && `${summary.removed} removed`,
  `${summary.unchanged} with no visual change`,
  summary.error && `⚠️ ${summary.error} failed`,
  problemCount && `<span class="warn">⚠️ ${problemCount} possible problem${problemCount > 1 ? 's' : ''}</span>`,
].filter(Boolean).join(' · ');
const runLine = run
  ? `<p class="muted">Checked ${run.routes.map((r) => `<code>${esc(r)}</code>`).join(', ')} at ${esc(run.viewports.join(', '))}${run.schemes.length > 1 ? ` (${esc(run.schemes.join(', '))})` : ''}: <code>${esc(run.base.sha.slice(0, 7))}</code> → <code>${esc(run.head.sha.slice(0, 7))}</code>${run.head.dirty ? ' + uncommitted changes' : ''}. Pages not listed were not checked.</p>`
  : '';
const summaryHtml = fs.existsSync(summaryPath) ? `<article class="summary">${markdown(fs.readFileSync(summaryPath, 'utf8'))}</article>` : '';

const errors = items.filter((x) => x.status === 'error');
const same = items.filter((x) => x.status === 'unchanged');
const listOf = (xs, fn) => `<ul>${xs.map((i) => `<li><code>${esc(i.route || i.name)}</code> — ${esc(label(i))}${fn(i)}</li>`).join('')}</ul>`;

const CSS = `
:root { --bg:#fff; --fg:#1f2328; --muted:#656d76; --line:#d0d7de; --card:#f6f8fa; --accent:#0969da; --warn:#9a6700; --warnbg:#fff8c5; --check:#eaeef2; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#8d96a0; --line:#30363d; --card:#161b22; --accent:#4493f8; --warn:#d29922; --warnbg:#2b2111; --check:#1c2128; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
main { max-width: 1200px; margin: 0 auto; padding: 0 16px 48px; }
h1 { font-size: 22px; margin: 24px 0 4px; } h2 { font-size: 18px; margin: 0 0 2px; word-break: break-word; } h3 { font-size: 15px; margin: 24px 0 8px; }
code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--card); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
.muted { color: var(--muted); margin: 4px 0; font-size: 14px; }
.warn { color: var(--warn); }
p.warn { background: var(--warnbg); border-radius: 6px; padding: 6px 10px; margin: 8px 0; }
.summary { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 4px 20px; margin: 16px 0; }
.summary h3, .summary h4 { margin: 14px 0 6px; } .summary ul { padding-left: 20px; }
nav { position: sticky; top: 0; z-index: 5; background: var(--bg); border-bottom: 1px solid var(--line); display: flex; gap: 8px; align-items: center; padding: 10px 0; margin: 16px 0; }
nav select { flex: 1; min-width: 0; }
button, select { font: inherit; color: var(--fg); background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 5px 10px; cursor: pointer; }
button:hover { border-color: var(--muted); } button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
.count { color: var(--muted); font-size: 14px; white-space: nowrap; }
.js .item { display: none; } .js .item.on { display: block; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 12px 0; }
.controls label { margin-left: 4px; cursor: pointer; user-select: none; }
img { display: block; max-width: 100%; height: auto; }
.view.phone .stage, .view.phone.single figure { max-width: 430px; }
.view.phone .side figure { max-width: 430px; }
.stage { position: relative; display: grid; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; touch-action: pan-y; cursor: ew-resize; user-select: none;
  background: repeating-conic-gradient(var(--check) 0 25%, var(--bg) 0 50%) 0 0 / 16px 16px; }
.layer { grid-area: 1 / 1; display: grid; align-self: start; } .layer img { grid-area: 1 / 1; width: 100%; pointer-events: none; }
.layer.before { clip-path: inset(0 calc(100% - var(--pos)) 0 0); }
.layer .diff { display: none; } .diff-on .layer .diff { display: block; }
.handle { position: absolute; top: 0; bottom: 0; left: var(--pos); width: 2px; margin-left: -1px; background: var(--accent); outline: none; }
.handle::after { content: "⇔"; position: absolute; top: min(50%, 45vh); width: 28px; height: 28px; margin: -14px 0 0 -13px; border-radius: 50%; background: var(--accent); color: #fff; text-align: center; line-height: 28px; font-size: 14px; }
.handle:focus-visible::after { box-shadow: 0 0 0 3px var(--bg), 0 0 0 5px var(--accent); }
.tag { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; background: rgba(0,0,0,.6); color: #fff; padding: 1px 6px; border-radius: 4px; }
.stage .tag { position: absolute; bottom: 8px; transition: opacity .15s; } .stage .tag.l { left: 8px; } .stage .tag.r { right: 8px; }
.stage:hover .tag { opacity: 0; } /* tags sit over the screenshot; get out of the way while inspecting */
.side { display: none; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: start; }
.view[data-mode="side"] .stage { display: none; } .view[data-mode="side"] .side { display: grid; }
.side .diffpane { display: none; } .diff-on .side { grid-template-columns: repeat(3, minmax(0, 1fr)); } .diff-on .side .diffpane { display: block; }
figure { margin: 0; } figure img { border: 1px solid var(--line); border-radius: 6px; }
figcaption { font-size: 13px; color: var(--muted); margin-bottom: 4px; } figcaption span { margin-left: 6px; }
.zooms { display: grid; gap: 16px; }
.trio { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; align-items: start; }
.trio.four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.trio .cap { display: block; font-size: 12px; color: var(--muted); text-transform: capitalize; }
.trio img { width: 100%; border: 1px solid var(--line); border-radius: 4px; background: var(--card); }
.problems { background: var(--warnbg); border-radius: 8px; padding: 2px 14px 8px; margin: 12px 0; } .problems h3 { margin: 10px 0 6px; } .problems ul { padding-left: 20px; margin: 0; }
.problems li { margin: 6px 0; word-break: break-word; } .pzoom { margin-top: 6px; max-height: 320px; width: auto; border: 1px solid var(--line); border-radius: 4px; }
.measured { padding-left: 20px; margin: 0; } .measured li { margin: 2px 0; word-break: break-word; }
section.rest { border-top: 1px solid var(--line); margin-top: 32px; } section.rest ul { padding-left: 20px; }
.empty { color: var(--muted); padding: 24px 0; }
@media (max-width: 640px) {
  .side, .diff-on .side { grid-template-columns: minmax(0, 1fr); }
  .trio, .trio.four { grid-template-columns: minmax(0, 1fr); }
}`;

// Item switching (buttons, select, ←/→, #hash), slider drag, mode + diff toggles.
const JS = `
const items = [...document.querySelectorAll('.item')];
const sel = document.getElementById('pick');
const count = document.getElementById('count');
let cur = 0;
function show(n, push) {
  if (!items.length) return;
  cur = (n + items.length) % items.length;
  items.forEach((el, k) => el.classList.toggle('on', k === cur));
  sel.value = items[cur].id;
  count.textContent = (cur + 1) + ' / ' + items.length;
  if (push) history.replaceState(null, '', '#' + items[cur].id);
}
document.getElementById('prev').onclick = () => show(cur - 1, true);
document.getElementById('next').onclick = () => show(cur + 1, true);
sel.onchange = () => show(items.findIndex((el) => el.id === sel.value), true);
document.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  const h = e.target.classList && e.target.classList.contains('handle');
  if (h) { // on the focused slider handle, arrows move the split instead
    const st = e.target.parentNode, p = parseFloat(st.style.getPropertyValue('--pos'));
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { set(st, p + (e.key === 'ArrowLeft' ? -5 : 5)); e.preventDefault(); }
    return;
  }
  if (e.key === 'ArrowLeft') { show(cur - 1, true); e.preventDefault(); }
  if (e.key === 'ArrowRight') { show(cur + 1, true); e.preventDefault(); }
});
function set(stage, p) {
  p = Math.max(0, Math.min(100, p));
  stage.style.setProperty('--pos', p + '%');
  stage.querySelector('.handle').setAttribute('aria-valuenow', Math.round(p));
}
document.querySelectorAll('.stage').forEach((st) => {
  const at = (e) => { const r = st.getBoundingClientRect(); set(st, ((e.clientX - r.left) / r.width) * 100); };
  st.addEventListener('pointerdown', (e) => { st.setPointerCapture(e.pointerId); at(e); });
  st.addEventListener('pointermove', (e) => { if (st.hasPointerCapture(e.pointerId)) at(e); });
});
items.forEach((it) => {
  const view = it.querySelector('.view[data-mode]');
  if (!view) return;
  it.querySelectorAll('[data-mode]').forEach((b) => b.tagName === 'BUTTON' && (b.onclick = () => {
    view.dataset.mode = b.dataset.mode;
    it.querySelectorAll('button[data-mode]').forEach((x) => x.setAttribute('aria-pressed', x === b));
  }));
  it.querySelector('.diff-toggle').onchange = (e) => view.classList.toggle('diff-on', e.target.checked);
});
const start = items.findIndex((el) => '#' + el.id === location.hash);
show(start < 0 ? 0 : start, false);`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UI diff</title>
<style>${CSS}</style>
${nav.length ? "<script>document.documentElement.classList.add('js')</script>" : ''}
</head>
<body>
<main>
<h1>UI diff</h1>
<p>${stats}</p>
${runLine}
${summaryHtml}
${nav.length ? `<nav>
  <button type="button" id="prev" aria-label="Previous (←)">←</button>
  <select id="pick" aria-label="Page">${nav.map(({ i, mark }) => `<option value="${id(i)}">${mark}${esc(title(i))}</option>`).join('')}</select>
  <button type="button" id="next" aria-label="Next (→)">→</button>
  <span class="count" id="count">${nav.length} items</span>
</nav>
${nav.map(({ i, mark, render }) => `<section class="item" id="${id(i)}" data-file="${esc(i.file)}">
  <h2>${mark}<code>${esc(i.route || i.name)}</code> — ${esc(label(i))}</h2>${render(i)}
</section>`).join('\n')}` : '<p class="empty">No visual changes in the pages checked.</p>'}
${errors.length ? `<section class="rest"><h3>⚠️ Failed to capture (${errors.length})</h3>${listOf(errors, (i) => `: ${esc(i.error)}`)}</section>` : ''}
${same.length ? `<section class="rest"><h3>No visual change (${same.length})</h3>${listOf(same, (i) => (noiseNote(i) ? ` <span class="muted">(${esc(noiseNote(i))})</span>` : '') + (i.warnings ? ` <span class="warn">⚠️ ${esc(i.warnings.join('; '))}</span>` : ''))}</section>` : ''}
<p class="muted">Generated with the ui-diff skill. ← / → switch pages.</p>
</main>
<script>${nav.length ? JS : ''}</script>
</body>
</html>
`;

fs.writeFileSync(outPath, html);
console.log(outPath);
