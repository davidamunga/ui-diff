#!/usr/bin/env node
// Render a GitHub-flavored markdown ui-diff report from run.sh output.
//
// Usage:
//   node comment.cjs --report .ui-diff/report [--base-url <prefix from publish.sh>] \
//     [--summary summary.md | --auto-summary] [--out comment.md] [--design <dir>] [--no-animate]
//     [--approval [<head sha>] [--no-checkbox --label <name>]]
//
// Changed areas lead with the animated before ⇄ after (diff.cjs's zoom flip APNGs), with
// the still pairs collapsed; --no-animate shows only the stills.
// --auto-summary writes a short factual summary from the measured changes, for runs with
// no agent to write summary.md (CI). It's labelled as automatic. --summary wins if both.
// Omit --base-url to get relative image paths (for previewing, or manual upload mode).
// Reads results.json (+ run.json for commits and coverage). The output is wrapped in
// <!-- ui-diff:start/end --> markers so post.cjs can replace it on later runs.
// Design comparisons from compare.cjs (<report>/design/*.json, or --design <dir> inside the
// report) get a "vs design" section; results.json may be absent when that's all there is.
// --approval (design review gate, see review.cjs) adds a "Design approved" box tied to the
// head commit when anything changed; --no-checkbox says to use the label instead.
const fs = require('fs');
const path = require('path');
const { args, noiseNote } = require('./lib.cjs');

const a = args();
if (!a.report) {
  console.error('Required: --report <dir>');
  process.exit(1);
}
const read = (f) => JSON.parse(fs.readFileSync(path.join(a.report, f), 'utf8'));
const { summary, items } = fs.existsSync(path.join(a.report, 'results.json')) ? read('results.json') : { summary: null, items: [] };
const designDir = a.design || path.join(a.report, 'design');
const designRel = path.relative(a.report, designDir).split(path.sep).join('/');
const designs = fs.existsSync(designDir)
  ? fs.readdirSync(designDir).filter((f) => f.endsWith('.json')).sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(designDir, f), 'utf8')))
      .filter((d) => d.kind === 'ui-diff/design-compare')
  : [];
const run = fs.existsSync(path.join(a.report, 'run.json')) ? read('run.json') : null;
if (a['base-url'] && !/^https?:\/\/\S+$/.test(a['base-url'])) {
  console.error(`--base-url doesn't look like a URL prefix: ${JSON.stringify(a['base-url'].slice(0, 200))}`);
  process.exit(1);
}
const url = (rel) => (a['base-url'] ? `${a['base-url']}/${rel}?raw=true` : rel);
const img = (rel, alt, width) => `<img src="${url(rel)}" alt="${alt}"${width ? ` width="${width}"` : ''}>`;
const label = (i) => [i.viewport, i.scheme && i.scheme !== 'light' ? i.scheme : null].filter(Boolean).join(' · ');
const warn = (i) => (i.warnings || []).map((w) => `> ⚠️ ${w}`);
const STATIC = '<details><summary>Before | After (still)</summary>\n';
// Tag + note per changed area (annotate.cjs / stylediff.cjs), shown under its animation.
const tag = (kind) => (kind === 'flow' ? '🔀 **Flow change**' : 'Visual only');
const caption = (r, n) => {
  const t = r.annotation;
  if (!t) return '';
  return `<sub>${String(n).includes(',') ? 'Areas' : 'Area'} ${n}: ${tag(t.kind)}${t.note ? ` · ${t.note.replace(/[<>|]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '|': '&#124;' })[c])}` : ''}</sub>`;
};
// Flow changes across the report, grouped by route ("New button …", "Link … now goes to …").
function flowLines() {
  const by = new Map();
  for (const i of items) {
    if (!i.flow || i.flow.kind !== 'flow') continue;
    const k = i.route || i.name;
    if (!by.has(k)) by.set(k, new Set());
    for (const c of i.flow.changes) by.get(k).add(c);
  }
  return [...by].map(([route, set]) => `- \`${route}\` — ${[...set].slice(0, 4).join('; ')}${set.size > 4 ? `; …and ${set.size - 4} more` : ''}`);
}
// Possible bugs new on head (stylediff.cjs), each with a zoom of the head screenshot.
const newProblems = (i) => (i.issues ? i.issues.new : []);
const problemCount = items.reduce((n, i) => n + newProblems(i).length, 0);
function problems(i) {
  const list = newProblems(i);
  if (!list.length) return [];
  const more = i.issues.omitted ? [`- …and ${i.issues.omitted} more (see measured.md)`] : [];
  return ['**⚠️ Possible problems** <sub>new in this PR · automated heuristics, worth a check</sub>', '',
    ...list.map((p) => `- ${p.line}${p.zoom ? `<br>${img(p.zoom, p.type, Math.min(p.zoomWidth || 600, 600))}` : ''}`), ...more, ''];
}

// Facts only (measured values, statuses, warnings), grouped by route across viewports.
function autoSummary() {
  const MAX = 8;
  const cap = (list) => (list.length > MAX ? [...list.slice(0, MAX), `- …and ${list.length - MAX} more`] : list);
  const vps = (list) => [...new Set(list.map(label))].join(', ');
  const routes = new Map();
  for (const i of items) {
    const k = i.route || i.name;
    if (!routes.has(k)) routes.set(k, []);
    routes.get(k).push(i);
  }
  const what = [];
  // The same issue on several pages/viewports/elements (e.g. a shared header) is one line.
  const look = new Map();
  const flag = (issue, route, i, el) => {
    if (!look.has(issue)) look.set(issue, { els: new Set(), routes: new Set(), items: [] });
    const f = look.get(issue);
    if (el) f.els.add(el);
    f.routes.add(route);
    f.items.push(i);
  };
  const few = (set, n) => [...set].slice(0, n).join(', ') + (set.size > n ? ', …' : '');
  // Possible problems lead "worth a look"; the same problem at several viewports is one line.
  const probs = new Map();
  for (const i of items) {
    for (const p of newProblems(i)) {
      if (!probs.has(p.line)) probs.set(p.line, { routes: new Set(), items: [], layout: p.type !== 'a11y' });
      probs.get(p.line).routes.add(i.route || i.name);
      probs.get(p.line).items.push(i);
    }
  }
  for (const [route, list] of routes) {
    const of = (st) => list.filter((i) => i.status === st);
    if (of('added').length) what.push(`- 🆕 \`${route}\` — new page (${vps(of('added'))})`);
    if (of('removed').length) what.push(`- 🗑️ \`${route}\` — page removed (${vps(of('removed'))})`);
    const changed = of('changed');
    if (changed.length) {
      const styles = new Map();
      let copy = 0, added = 0, removed = 0, shift = 0, pct = 0, resize = null;
      for (const i of changed) {
        pct = Math.max(pct, i.percent || 0);
        const m = i.measured;
        if (!m || !m.styles) continue;
        for (const g of m.styles) styles.set(`${g.prop}|${g.from}|${g.to}`, g);
        copy = Math.max(copy, m.copy.length);
        added = Math.max(added, m.addedCount);
        removed = Math.max(removed, m.removedCount);
        if (m.moves.length) shift = Math.max(shift, Math.abs(m.moves[0].dy) || Math.abs(m.moves[0].dx));
        if (!resize && m.resizes && m.resizes.length) resize = m.resizes[0];
      }
      const g = [...styles.values()];
      const facts = g.slice(0, 3).map((x) => `\`${x.prop}\` ${x.from} → ${x.to}`);
      if (g.length > 3) facts.push(`${g.length - 3} more style change${g.length > 4 ? 's' : ''}`);
      if (copy) facts.push(`${copy} text change${copy > 1 ? 's' : ''}`);
      if (added) facts.push(`${added} element${added > 1 ? 's' : ''} added`);
      if (removed) facts.push(`${removed} element${removed > 1 ? 's' : ''} removed`);
      if (shift) facts.push(`content shifted by up to ${shift}px`);
      // A size change with no tracked style change (e.g. max-width, flex/grid sizing).
      if (!g.length && resize) facts.push(resize.count > 1 ? `${resize.count} elements resized (${resize.els[0]}, …)` : `${resize.el} resized ${resize.from} → ${resize.to}`);
      if (!facts.length) facts.push(`${pct}% of pixels changed with no computed-style differences (images, canvas or non-DOM content)`);
      what.push(`- \`${route}\` (${vps(changed)}) — ${facts.join('; ')}`);
    }
    for (const i of list) {
      const m = i.measured;
      if (m && m.contrast) {
        for (const c of m.contrast) flag(`contrast ${c.ratio}:1 (needs ${c.min}:1), ${c.fg} on ${c.bg}${c.was ? ` (was ${c.was}:1)` : ''}`, route, i, c.el);
      } else if (m && i.status === 'added') {
        // New pages only have pre-formatted lines: "⚠️ contrast R:1 (needs M:1): <el>, <fg> on <bg>"
        for (const l of m.lines) {
          const x = l.match(/^⚠️ (contrast \S+ \(needs \S+\)): (.*), (\S+(?: @ \d+%)? on \S+(?: @ \d+%)?)$/);
          if (x) flag(`${x[1]}, ${x[3]}`, route, i, x[2]);
          else flag(l.replace(/^⚠️ /, ''), route, i);
        }
      }
      // A new page 404s on base (and a removed one on head); that's what new means, not an issue.
      const expected = { added: 'base returned HTTP', removed: 'head returned HTTP' }[i.status];
      for (const w of i.warnings || []) if (!(expected && w.startsWith(expected))) flag(w, route, i);
      if (i.status === 'error') flag(`failed to capture: ${i.error}`, route, i);
    }
  }
  const out = ['<sub>🤖 Automatic summary from measured changes; not written or reviewed by a person.</sub>', ''];
  if (!what.length && !look.size && !probs.size) return [...out, 'No visual changes on the checked pages.'].join('\n');
  if (what.length) out.push('**What changed**', ...cap(what), '');
  const flows = flowLines();
  if (flows.length) out.push('**🔀 Flow changes** <sub>what users can do or where they go</sub>', ...cap(flows), '');
  else if (what.length) out.push('<sub>Visual only: no controls, links, fields or pages were added, removed or retargeted.</sub>', '');
  if (look.size || probs.size) {
    const where = (f) => `${few(new Set([...f.routes].map((r) => `\`${r}\``)), 4)} (${vps(f.items)})`;
    const pl = [...probs].sort(([, x], [, y]) => y.layout - x.layout).map(([line, f]) => `- ⚠️ ${line} — ${where(f)}`);
    const lines = [...look].map(([issue, f]) => `- ⚠️ ${issue}${f.els.size ? `: ${few(f.els, 3)}` : ''} — ${where(f)}`);
    out.push('**Worth a look**', ...cap([...pl, ...lines]));
  }
  return out.join('\n');
}

const out = ['<!-- ui-diff:start -->', '## 🎨 UI diff', ''];

if (a.summary && fs.existsSync(a.summary)) out.push(fs.readFileSync(a.summary, 'utf8').trim(), '');
else if (a['auto-summary']) out.push(autoSummary(), '');

const stats = summary ? [
  summary.changed && `**${summary.changed} changed**`,
  summary.added && `${summary.added} new`,
  summary.removed && `${summary.removed} removed`,
  `${summary.unchanged} with no visual change`,
  summary.error && `⚠️ ${summary.error} failed`,
].filter(Boolean) : [];
if (designs.length) stats.push(`${designs.length} compared with the design`);
if (problemCount) stats.push(`⚠️ ${problemCount} possible problem${problemCount > 1 ? 's' : ''}`);
out.push(`<sub>${stats.join(' · ')}</sub>`);
if (run) {
  const head = `\`${run.head.sha.slice(0, 7)}\`${run.head.dirty ? ' + uncommitted changes' : ''}`;
  out.push(`<sub>Checked ${run.storybook ? 'stories ' : ''}${run.routes.map((r) => `\`${r}\``).join(', ')} at ${run.viewports.join(', ')}${run.schemes.length > 1 ? ` (${run.schemes.join(', ')})` : ''} — \`${run.base.sha.slice(0, 7)}\` → ${head}. ${run.storybook ? 'Stories' : 'Pages'} not listed were not checked.</sub>`);
}
out.push('');
if (a.approval) {
  const review = require('./review.cjs');
  const c = review.counts(items);
  const sha = a.approval === true ? run && run.head.sha : a.approval;
  if (c.pages + c.failed && sha) out.push(review.block({ sha, ...c, checkbox: !a['no-checkbox'], label: a.label }), '');
}

for (const i of items.filter((x) => x.status === 'changed')) {
  const size = i.sizeChanged ? ` · height ${i.before.height}→${i.after.height}px` : '';
  const noise = noiseNote(i);
  const flowTag = i.flow ? ` · ${i.flow.kind === 'flow' ? '🔀 flow change' : 'visual only'}` : '';
  out.push(`### \`${i.route || i.name}\` — ${label(i)}`, `<sub>${i.percent}% of pixels changed${size}${noise ? ` · ${noise}` : ''}${flowTag}</sub>`, '', ...warn(i), ...problems(i));
  const zoomed = (i.regions || []).filter((r) => r.zoom);
  // Animated before ⇄ after first; the static pairs move into a collapsed block.
  const flips = a['no-animate'] ? [] : zoomed.filter((r) => r.zoom.flip);
  if (flips.length) {
    if (flips.some((r) => r.annotation)) {
      // Areas with the same tag and note share one caption; flow changes lead.
      const groups = new Map();
      flips.forEach((r, n) => {
        const k = r.annotation ? `${r.annotation.kind}\u0000${r.annotation.note}` : '';
        if (!groups.has(k)) groups.set(k, { r, ns: [] });
        groups.get(k).ns.push(n);
      });
      const order = [...groups.values()].sort((x, y) => ((y.r.annotation || {}).kind === 'flow') - ((x.r.annotation || {}).kind === 'flow'));
      for (const g of order) {
        out.push(g.ns.map((n) => img(flips[n].zoom.flip, `area ${n + 1}: before, then after (animated)`)).join(' '));
        out.push(caption(g.r, g.ns.length > 1 ? g.ns.map((n) => n + 1).join(', ') : g.ns[0] + 1), '');
      }
      out.push(STATIC);
    } else out.push(flips.map((r, n) => img(r.zoom.flip, `area ${n + 1}: before, then after (animated)`)).join(' '), '', STATIC);
  } else if (zoomed.some((r) => r.annotation)) out.push(...zoomed.map((r, n) => caption(r, n + 1)), '');
  if (zoomed.length) {
    out.push('| Before | After |', '|---|---|');
    for (const r of zoomed) out.push(`| ${img(r.zoom.before, 'before')} | ${img(r.zoom.after, 'after')} |`);
    out.push('');
  }
  if (flips.length) out.push('</details>', '');
  if (i.regionsOmitted) out.push(`<sub>+${i.regionsOmitted} more changed area${i.regionsOmitted > 1 ? 's' : ''} — see the full page below.</sub>`, '');
  if (i.measured && i.measured.lines.length) {
    out.push('<details><summary>Measured changes</summary>', '', ...i.measured.lines.map((l) => `- ${l}`), '', '</details>', '');
  }
  out.push(zoomed.length ? '<details><summary>Full page + diff overlay</summary>' : '<details open><summary>Full page + diff overlay</summary>', '');
  out.push('| Before | After | Diff |', '|---|---|---|');
  out.push(`| ${img(`before/${i.file}`, 'before', 300)} | ${img(`after/${i.file}`, 'after', 300)} | ${img(`diff/${i.file}`, 'diff', 300)} |`);
  out.push('', '</details>', '');
}

for (const i of items.filter((x) => x.status === 'added')) {
  out.push(`### 🆕 \`${i.route || i.name}\` — ${label(i)}`, '', ...warn(i), ...problems(i), img(`after/${i.file}`, 'new', 400), '');
}

// No pixel change, but a check found something new (e.g. a removed alt text or aria-label).
for (const i of items.filter((x) => x.status === 'unchanged' && newProblems(x).length)) {
  out.push(`### \`${i.route || i.name}\` — ${label(i)}`, '<sub>No visual change</sub>', '', ...problems(i));
}

for (const i of items.filter((x) => x.status === 'removed')) {
  out.push(`### 🗑️ \`${i.route || i.name}\` — ${label(i)}`, '', ...warn(i), img(`before/${i.file}`, 'removed', 400), '');
}

if (designs.length) {
  out.push('### 📐 vs design', '<sub>Implementation (head) next to the Figma frame. Fonts, real data and rendering always differ a little; boxed areas are prompts for a look, not failures.</sub>', '');
  for (const d of designs) {
    const src = (rel) => `${designRel}/${rel}`;
    const frame = d.figma ? `[Figma frame](${d.figma}) · ` : '';
    out.push(`#### \`${d.label || d.name}\``, `<sub>${frame}${d.percent}% of pixels differ at ${d.compared.width}px wide · ${d.regions.length ? `${d.regions.length} area${d.regions.length === 1 ? '' : 's'} boxed` : 'nothing stood out'}</sub>`, '');
    for (const n of d.notes || []) out.push(`> ℹ️ ${n}`);
    const zoomed = d.regions.filter((r) => r.zoom);
    if (zoomed.length) {
      out.push('', '| Design | Implementation |', '|---|---|');
      for (const r of zoomed) out.push(`| ${img(src(r.zoom.design), 'design')} | ${img(src(r.zoom.actual), 'implementation')} |`);
    }
    out.push('', `<details${zoomed.length ? '' : ' open'}><summary>Design · implementation · diff</summary>`, '', img(src(d.composite), 'design, implementation and diff side by side'), '', '</details>', '');
  }
}

const errors = items.filter((x) => x.status === 'error');
if (errors.length) {
  out.push('<details><summary>⚠️ Failed to capture</summary>', '');
  for (const i of errors) out.push(`- \`${i.route || i.name}\` (${label(i)}): ${i.error}`);
  out.push('', '</details>', '');
}

const same = items.filter((x) => x.status === 'unchanged');
if (same.length) {
  out.push(`<details><summary>No visual change (${same.length})</summary>`, '');
  for (const i of same) out.push(`- \`${i.route || i.name}\` — ${label(i)}${noiseNote(i) ? ` (${noiseNote(i)})` : ''}${i.warnings ? ` ⚠️ ${i.warnings.join('; ')}` : ''}`);
  out.push('', '</details>', '');
}

out.push('<sub>Generated with the ui-diff skill</sub>', '<!-- ui-diff:end -->');
let md = out.join('\n').replace(/\n{3,}/g, '\n\n');
// Too long: the animations already show each change, so drop their still copies first.
if (md.length > 60000) md = md.split(STATIC).map((s, n) => (n ? s.slice(s.indexOf('</details>') + 10) : s)).join('').replace(/\n{3,}/g, '\n\n');
// GitHub rejects comment/PR bodies over 65,536 chars.
if (md.length > 60000) {
  console.error(`warning: report is ${md.length} chars (GitHub limit 65536) — capture fewer routes/viewports or split the comment.`);
}
if (a.out) fs.writeFileSync(a.out, md);
else process.stdout.write(md + '\n');
