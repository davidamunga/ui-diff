#!/usr/bin/env node
// Screenshot a list of routes on a running web app, deterministically, and record a
// computed-style snapshot of every visible element (used by stylediff.cjs).
//
// Usage:
//   node capture.cjs --url http://localhost:3001 --out shots/before \
//     [--routes "/,/settings"] [--config .ui-diff.json] \
//     [--viewports "desktop:1440x900,mobile:iPhone 13"] [--schemes light,dark] \
//     [--time <epoch ms>] [--only "a__desktop.png,b__mobile.png"] [--no-checks]
//
// --routes are added to the config's routes. --viewports/--schemes override the config.
// --time: the instant the page clock starts at (config "clock" wins; default now). run.sh passes
// the same value to base and head so dates and "x minutes ago" render the same on both.
// --only: capture just these output files (run.sh's re-check of changed pages on base).
// Writes <out>/<name>__<viewport>[__<scheme>].png, a matching .styles.json and .issues.json
// (possible bugs: clipped text, sideways scroll, overlap, off-screen controls, small tap
// targets on mobile, axe-core WCAG A/AA violations), and manifest.json.
const fs = require('fs');
const path = require('path');
const { need, args, slug, TOOLS_DIR } = require('./lib.cjs');
const { chromium, devices } = need('playwright');

const DEFAULT_VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { device: 'iPhone 13' } };

// Kill motion and blinking so two captures of identical UI produce identical pixels.
const STABILIZE_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important; animation-delay: 0s !important;
  transition-duration: 0s !important; transition-delay: 0s !important;
  caret-color: transparent !important; scroll-behavior: auto !important;
}`;

// Framework dev-mode chrome that would otherwise show up in screenshots.
// Errors they would have displayed are still recorded (see devOverlayError below).
const DEV_OVERLAYS = [
  'nextjs-portal', '#__next-build-watcher', '#__next-prerender-indicator',
  'vite-error-overlay', '#webpack-dev-server-client-overlay', 'astro-dev-toolbar',
  '#nuxt-devtools-container', '#svelte-inspector-host', '.tsqd-parent-container',
];

// Same seed on both sides: code that calls Math.random in the same order gets the same numbers.
function seedRandom(seed) {
  let t = seed >>> 0;
  Math.random = () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// The instant page clocks start at, or null to leave the real clock alone. Time still flows
// from there (timers, debounce and animation frames work); it just starts at the same moment.
function clockStart(cfg, a) {
  if (cfg.clock === false) return null;
  const t = cfg.clock !== undefined ? (typeof cfg.clock === 'number' ? cfg.clock : Date.parse(cfg.clock)) : Number(a.time || Date.now());
  if (!Number.isFinite(t)) throw new Error(`"clock" must be a date like "2025-06-01T12:00:00Z", a timestamp in ms, or false; got ${JSON.stringify(cfg.clock)}`);
  return t;
}

function parseViewports(spec) {
  if (!spec) return null;
  const out = {};
  for (const part of spec.split(',')) {
    const i = part.indexOf(':');
    const name = part.slice(0, i);
    const rest = part.slice(i + 1).trim();
    const m = rest.match(/^(\d+)x(\d+)$/);
    out[name] = m ? { width: Number(m[1]), height: Number(m[2]) } : { device: rest };
  }
  return out;
}

// Browser context options for one viewport. Named devices get real mobile emulation
// (touch, mobile UA, isMobile) so responsive code that checks for them behaves as on a phone.
function contextFor(vp, cfg) {
  if (vp.device) {
    const d = devices[vp.device];
    if (!d) throw new Error(`Unknown Playwright device "${vp.device}"`);
    const { defaultBrowserType, ...opts } = d;
    return { ...opts, deviceScaleFactor: Number(cfg.deviceScaleFactor || Math.min(d.deviceScaleFactor, 2)) };
  }
  return { viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: Number(cfg.deviceScaleFactor || 1) };
}

function mergeRoutes(cfgRoutes, cliRoutes) {
  const list = (cfgRoutes || []).map((r) => (typeof r === 'string' ? { path: r } : r));
  for (const p of cliRoutes) if (!list.some((r) => r.path === p && !r.actions)) list.push({ path: p });
  if (!list.length) list.push({ path: '/' });
  return list.map((r) => ({ name: r.name || slug(r.path), ...r }));
}

// A route's Figma frame for one viewport: a string means the first viewport,
// an object maps viewport name → frame URL (see references/figma.md).
function figmaFor(route, vpName, firstVp) {
  const f = route.figma;
  if (!f) return null;
  return typeof f === 'string' ? (vpName === firstVp ? f : null) : f[vpName] || null;
}

// Bring the page into a state a plain load doesn't show (open modal, hover, filled form).
// Each action is one of: {click}, {hover}, {fill: [selector, value]}, {press: key}, {wait: ms|selector}
async function runAction(page, act) {
  if (act.click) await page.click(act.click);
  else if (act.hover) await page.hover(act.hover);
  else if (act.fill) await page.fill(act.fill[0], act.fill[1]);
  else if (act.press) await page.keyboard.press(act.press);
  else if (typeof act.wait === 'number') await page.waitForTimeout(act.wait);
  else if (act.wait) await page.waitForSelector(act.wait);
}

// Runs in the page. One record per visible element: DOM path, short label, page-space box,
// a fixed set of computed styles, and WCAG contrast for elements that hold text.
function snapshotStyles() {
  const PROPS = [
    'color', 'background-color', 'background-image', 'font-family', 'font-size', 'font-weight',
    'line-height', 'letter-spacing', 'text-transform', 'text-decoration-line', 'text-align',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-color', 'border-top-style', 'border-radius', 'box-shadow', 'opacity',
    'display', 'flex-direction', 'justify-content', 'align-items', 'gap', 'grid-template-columns',
    'max-width', 'min-width', 'max-height', 'min-height',
  ];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'BR']);
  const MAX = 4000;
  const CONTROL = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem]';
  // Normalize any CSS color (rgb, oklch, color(), named) to sRGB via a 1px canvas.
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgbCache = new Map();
  const toRgba = (c) => {
    if (rgbCache.has(c)) return rgbCache.get(c);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    const v = [r, g, b, a / 255];
    rgbCache.set(c, v);
    return v;
  };
  const hex = ([r, g, b]) => '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  // First ancestor-or-self with a solid-ish background; null if an image/gradient is in the way.
  const effectiveBg = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const c = toRgba(cs.backgroundColor);
      if (c[3] > 0.5) return c;
    }
    return [255, 255, 255, 1];
  };
  const out = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (out.length >= MAX || SKIP.has(el.tagName)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    const tags = [];
    for (let n = el; n && n !== document.body; n = n.parentElement) tags.unshift(n.tagName.toLowerCase());
    const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    const ident = el.id || el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.getAttribute('name') ||
      (el.tagName === 'IMG' ? el.getAttribute('alt') || (el.getAttribute('src') || '').split('/').pop() : '') || '';
    const s = {};
    for (const p of PROPS) s[p] = cs.getPropertyValue(p);
    const rec = {
      path: tags.join('>'),
      tag: el.tagName.toLowerCase(),
      cls: [...el.classList].slice(0, 2).map((c) => c.slice(0, 24)),
      text, ident,
      box: [Math.round(r.x + scrollX), Math.round(r.y + scrollY), Math.round(r.width), Math.round(r.height)],
      s,
    };
    // Controls: what a user can do here, for spotting flow changes (stylediff.cjs).
    if (el.matches(CONTROL)) {
      const t = el.tagName.toLowerCase();
      const fieldLabel = () => {
        if (el.labels && el.labels[0]) {
          const l = el.labels[0].cloneNode(true); // the label's own words, not the control's options
          l.querySelectorAll('input, select, textarea').forEach((n) => n.remove());
          if (l.textContent.trim()) return l.textContent;
        }
        return el.getAttribute('placeholder') || el.getAttribute('name') || '';
      };
      const lbl = el.getAttribute('aria-label') ||
        (['input', 'select', 'textarea'].includes(t) ? fieldLabel() : el.innerText || el.getAttribute('value') || el.getAttribute('title') || '');
      const ia = { kind: t === 'a' ? 'link' : ['input', 'select', 'textarea'].includes(t) ? 'field' : el.getAttribute('role') || (t === 'summary' ? 'disclosure' : 'button'),
        label: lbl.replace(/\s+/g, ' ').trim().slice(0, 60) };
      if (t === 'a') {
        try { const u = new URL(el.href, location.href); ia.href = u.origin === location.origin ? u.pathname + u.search + u.hash : u.href; } catch {}
      }
      if (t === 'input') ia.type = el.type;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') ia.disabled = true;
      if (el.required) ia.required = true;
      rec.ia = ia;
    }
    if (text) {
      const fg = toRgba(cs.color);
      const bg = effectiveBg(el);
      if (bg && fg[3] > 0.5) {
        const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
        const size = parseFloat(cs.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
        rec.contrast = { ratio: Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100, fg: hex(fg), bg: hex(bg), min: large ? 3 : 4.5 };
      }
    }
    out.push(rec);
  }
  return { truncated: out.length >= MAX, dpr: devicePixelRatio, elements: out };
}

// Runs in the page. Heuristic layout checks; stylediff.cjs keeps only the ones that are new on
// head. Each issue names its element(s) the way snapshotStyles does (path + text/ident), so the
// same problem on base and head gets the same key. Boxes are page-space CSS px.
//   opts: { mobile, ignore: [selectors], off: { textClipping, pageOverflow, overlap, offscreen, tapTargets } }
function detectIssues(opts) {
  const MAX = 3000; // elements examined
  const vw = document.documentElement.clientWidth;
  const ignored = (el) => opts.ignore.some((s) => { try { return el.closest(s); } catch { return false; } });
  const who = (el) => {
    const tags = [];
    for (let n = el; n && n !== document.body; n = n.parentElement) tags.unshift(n.tagName.toLowerCase());
    const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    const ident = el.id || el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.getAttribute('name') ||
      (el.tagName === 'IMG' ? el.getAttribute('alt') || (el.getAttribute('src') || '').replace(/^data:.*/, '').split('/').pop().slice(0, 60) : '') || '';
    return { path: tags.join('>'), tag: el.tagName.toLowerCase(), cls: [...el.classList].slice(0, 2).map((c) => c.slice(0, 24)), text: text || (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80), ident };
  };
  const box = (r) => [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)];
  const visible = (el) => el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true;
  // Screen-reader-only / visually hidden patterns: tiny, clipped away, or aria-hidden.
  const srOnly = (el, r, cs) => r.width <= 2 || r.height <= 2 || (cs.clip && cs.clip !== 'auto') ||
    /inset\(50%|inset\(100%/.test(cs.clipPath) || el.closest('[aria-hidden="true"], [inert]');
  const positioned = (el, kinds) => { for (let n = el; n && n !== document.body; n = n.parentElement) if (kinds.includes(getComputedStyle(n).position)) return true; return false; };
  const INTERACTIVE = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem]';
  const textRects = (el) => {
    const rects = [];
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      const rg = document.createRange();
      rg.selectNodeContents(n);
      for (const r of rg.getClientRects()) if (r.width > 0 && r.height > 0) rects.push(r);
    }
    return rects;
  };
  // The parts of rects not cut away by clipping ancestors (for overlap: hidden lines don't count).
  const clipRects = (el, rects) => {
    let c = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const acs = getComputedStyle(a);
      if (acs.overflowX === 'visible' && acs.overflowY === 'visible') continue;
      const ar = a.getBoundingClientRect();
      c = { left: Math.max(c.left, ar.left), top: Math.max(c.top, ar.top), right: Math.min(c.right, ar.right), bottom: Math.min(c.bottom, ar.bottom) };
    }
    return rects.map((r) => {
      const left = Math.max(r.left, c.left), top = Math.max(r.top, c.top), right = Math.min(r.right, c.right), bottom = Math.min(r.bottom, c.bottom);
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    }).filter((r) => r.width > 0 && r.height > 0);
  };
  const union = (rs) => rs.reduce((u, r) => ({ left: Math.min(u.left, r.left), top: Math.min(u.top, r.top), right: Math.max(u.right, r.right), bottom: Math.max(u.bottom, r.bottom) }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  const issues = [];

  // Candidate elements: visible, not ignored, not visually hidden.
  const textEls = [];
  const targets = [];
  let n = 0;
  for (const el of document.body.querySelectorAll('*')) {
    if (++n > MAX) break;
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|svg|path)$/.test(el.tagName)) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const isTarget = el.matches(INTERACTIVE) && !el.disabled;
    const rects = textRects(el);
    if (!rects.length && !isTarget) continue;
    if (!visible(el) || ignored(el)) continue;
    if (isTarget && (r.width < 1 || r.height < 1)) {
      // Interactive, in normal flow, with a label, yet no size: squashed (flex shrink, width: 0).
      if (!opts.off.offscreen && cs.display !== 'contents' && /static|relative/.test(cs.position) && (el.innerText || '').trim() && !srOnly(el, { width: 9, height: 9 }, cs)) {
        issues.push({ type: 'offscreen', el: who(el), box: box(r), detail: { zero: true } });
      }
      continue;
    }
    if (srOnly(el, r, cs)) continue;
    if (rects.length) textEls.push({ el, r, cs, rects, tb: union(rects), vis: clipRects(el, rects) });
    if (isTarget) targets.push({ el, r, cs });
  }

  // Text cut off by its own box or a clipping ancestor (overflow hidden/clip, ellipsis, line clamp).
  // Only partial clipping counts: text that's entirely outside its clip box (carousel slides,
  // collapsed panels) is hidden on purpose.
  if (!opts.off.textClipping) {
    for (const t of textEls) {
      const tb = t.tb;
      let hops = 0;
      for (let a = t.el; a && a !== document.body && a !== document.documentElement && hops < 8; a = a.parentElement, hops++) {
        const acs = a === t.el ? t.cs : getComputedStyle(a);
        const ox = /hidden|clip/.test(acs.overflowX), oy = /hidden|clip/.test(acs.overflowY);
        if (/auto|scroll/.test(acs.overflowX + acs.overflowY)) break; // scrollable: reachable, not clipped
        if (!ox && !oy) continue;
        const ar = a.getBoundingClientRect();
        const c = { left: ar.left + a.clientLeft, top: ar.top + a.clientTop };
        c.right = c.left + a.clientWidth; c.bottom = c.top + a.clientHeight;
        // Clipped by an ancestor: only when the text spills out of its own element and that
        // element still fits the clip box. A whole element cropped by a container (mock-ups
        // in a hero, slides) is layout, not overflowing text.
        const own = t.r;
        const fitsX = a === t.el || (own.left >= c.left - 2 && own.right <= c.right + 2);
        const fitsY = a === t.el || (own.top >= c.top - 2 && own.bottom <= c.bottom + 2);
        const cutX = ox && fitsX ? Math.max(0, c.left - tb.left) + Math.max(0, tb.right - c.right) : 0;
        const cutY = oy && fitsY ? Math.max(0, c.top - tb.top) + Math.max(0, tb.bottom - c.bottom) : 0;
        const inside = Math.min(tb.right, c.right) > Math.max(tb.left, c.left) && Math.min(tb.bottom, c.bottom) > Math.max(tb.top, c.top);
        // Glyph boxes overhang tight line-heights a little; a clamped line is a whole line.
        if (inside && (cutX >= 4 || cutY >= Math.max(4, parseFloat(t.cs.fontSize) * 0.4))) {
          const ellipsis = t.cs.textOverflow === 'ellipsis' && cutX >= 4;
          const clamp = acs.webkitLineClamp && acs.webkitLineClamp !== 'none';
          issues.push({ type: 'textClipping', el: who(t.el), box: box(a.getBoundingClientRect()),
            detail: { how: ellipsis ? 'ellipsis' : clamp ? 'line-clamp' : 'overflow', text: [Math.round(tb.right - tb.left), Math.round(tb.bottom - tb.top)], clip: [Math.round(c.right - c.left), Math.round(c.bottom - c.top)], by: a === t.el ? null : who(a).tag } });
        }
        break; // the nearest clipping box decides
      }
    }
  }

  // Sideways scroll: the page is wider than the viewport. Name the outermost offenders.
  const docW = document.documentElement.scrollWidth;
  if (!opts.off.pageOverflow && docW > vw + 1) {
    const over = [];
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.right + scrollX <= vw + 1 || r.width < 1 || ignored(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed') continue;
      // Inside a box that clips or scrolls and itself fits (carousels, scrollable tables): fine.
      let held = false;
      for (let q = el.parentElement; q && q !== document.body && !held; q = q.parentElement) {
        held = getComputedStyle(q).overflowX !== 'visible' && q.getBoundingClientRect().right + scrollX <= vw + 1;
      }
      if (held) continue;
      const p = el.parentElement;
      // Root cause: its parent still fits (or is the body).
      if (p && p !== document.body && p.getBoundingClientRect().right + scrollX > vw + 1) continue;
      over.push({ el, r });
    }
    over.sort((x, y) => y.r.right - x.r.right);
    if (over.length) {
      issues.push({ type: 'pageOverflow', el: who(over[0].el), box: box(over[0].r),
        detail: { page: docW, viewport: vw, widest: over.slice(0, 3).map((o) => ({ ...who(o.el), right: Math.round(o.r.right + scrollX) })) } });
    }
  }

  // Interactive elements in normal flow that ended up outside the page horizontally (unreachable).
  // Skip links and sr-only controls park themselves off-screen with absolute/fixed positioning.
  if (!opts.off.offscreen) {
    const right = Math.max(docW, vw);
    for (const t of targets) {
      if (!/static|relative/.test(t.cs.position) || positioned(t.el.parentElement, ['absolute', 'fixed'])) continue;
      if (t.r.right + scrollX <= 0 || t.r.left + scrollX >= right) {
        issues.push({ type: 'offscreen', el: who(t.el), box: box(t.r), detail: { x: Math.round(t.r.left + scrollX) } });
        continue;
      }
      // Pushed fully out of its own parent's clipped box (e.g. a flex row with overflow hidden).
      // Only the direct parent: carousels clip slides a few levels up.
      const p = t.el.parentElement, pcs = p && getComputedStyle(p);
      if (p && p !== document.body && /hidden|clip/.test(pcs.overflowX + pcs.overflowY)) {
        const pr = p.getBoundingClientRect();
        if (t.r.left >= pr.right || t.r.right <= pr.left || t.r.top >= pr.bottom || t.r.bottom <= pr.top) {
          issues.push({ type: 'offscreen', el: who(t.el), box: box(pr), detail: { clipped: who(p).tag } });
        }
      }
    }
  }

  // Overlap between text and/or controls that don't contain each other. Fixed/sticky layers,
  // pointer-events:none, and labels/adornments on form controls are intentional overlays.
  if (!opts.off.overlap) {
    const control = (el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
    const items = [];
    for (const t of textEls) if (t.vis.length) items.push({ el: t.el, rects: t.vis, cs: t.cs });
    // Controls by their box (clipped like text). Absolutely positioned ones are skipped: the
    // "stretched link" pattern lays an empty link over a whole card on purpose.
    for (const t of targets) {
      if (items.some((i) => i.el === t.el) || t.cs.position === 'absolute') continue;
      const vis = clipRects(t.el, [t.r]);
      if (vis.length) items.push({ el: t.el, rects: vis, cs: t.cs });
    }
    const ok = items.filter((i) => i.cs.pointerEvents !== 'none' && !positioned(i.el, ['fixed', 'sticky']));
    const area = (r) => r.width * r.height;
    const seen = new Set();
    for (const i of ok) i.u = union(i.rects);
    ok.sort((x, y) => x.u.top - y.u.top);
    for (let i = 0; i < ok.length; i++) {
      for (let j = i + 1; j < ok.length && ok[j].u.top < ok[i].u.bottom; j++) {
        const A = ok[i], B = ok[j];
        if (A.u.right <= B.u.left || B.u.right <= A.u.left) continue;
        if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
        if ((control(A.el) || control(B.el)) && (A.el.closest('label') || B.el.closest('label') || A.cs.position === 'absolute' || B.cs.position === 'absolute')) continue;
        let best = null;
        for (const ra of A.rects) for (const rb of B.rects) {
          const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
          const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
          if (w < 4 || h < 4) continue;
          if (w * h < 0.25 * Math.min(area(ra), area(rb))) continue;
          if (!best || w * h > best.w * best.h) best = { x: Math.max(ra.left, rb.left), y: Math.max(ra.top, rb.top), w, h };
        }
        if (!best) continue;
        if (seen.has(A.el) && seen.has(B.el)) continue;
        seen.add(A.el); seen.add(B.el);
        issues.push({ type: 'overlap', el: who(A.el), other: who(B.el), box: box({ left: best.x, top: best.y, width: best.w, height: best.h }), detail: { w: Math.round(best.w), h: Math.round(best.h) } });
        if (issues.length > 200) break;
      }
    }
  }

  // WCAG 2.5.8 target size (mobile viewports only): under 24×24 CSS px, unless it's an inline
  // link in a sentence, a native unstyled checkbox/radio, or spaced so a 24px circle around it
  // touches no other target.
  if (opts.mobile && !opts.off.tapTargets) {
    const small = targets.filter((t) => (t.r.width < 24 || t.r.height < 24) && !(t.cs.display === 'inline' && t.el.parentElement &&
      [...t.el.parentElement.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) &&
      !(/^(checkbox|radio)$/.test(t.el.type) && t.cs.appearance !== 'none'));
    const center = (r) => [r.left + r.width / 2, r.top + r.height / 2];
    const dist = ([x, y], r) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
    for (const t of small) {
      const c = center(t.r);
      const crowded = targets.some((o) => o !== t && !o.el.contains(t.el) && !t.el.contains(o.el) &&
        (dist(c, o.r) < 12 || (small.includes(o) && Math.hypot(c[0] - center(o.r)[0], c[1] - center(o.r)[1]) < 24)));
      if (crowded) issues.push({ type: 'tapTargets', el: who(t.el), box: box(t.r), detail: { w: Math.round(t.r.width), h: Math.round(t.r.height) } });
    }
  }
  return { dpr: devicePixelRatio, viewport: vw, issues };
}

// Runs in the page after axe-core was injected: WCAG 2 A/AA violations, one record per element.
// color-contrast is off: stylediff.cjs has its own contrast check (with base → head ratios).
async function runAxe(opts) {
  const res = await axe.run({ exclude: opts.ignore.map((s) => [s]) }, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    rules: Object.fromEntries(['color-contrast', ...opts.ignoreRules].map((r) => [r, { enabled: false }])),
    resultTypes: ['violations'], elementRef: true,
  });
  const out = [];
  for (const v of res.violations) {
    for (const node of v.nodes.slice(0, 20)) {
      const el = node.element;
      const tags = [];
      for (let n = el; n && n !== document.body && n.parentElement; n = n.parentElement) tags.unshift(n.tagName.toLowerCase());
      const ident = el ? el.id || el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.getAttribute('name') ||
        (el.tagName === 'IMG' ? (el.getAttribute('src') || '').replace(/^data:.*/, '').split('/').pop().slice(0, 60) : '') || '' : '';
      // Own text only (a whole-page violation like html-has-lang mustn't change key with the copy);
      // controls use their full label.
      const own = el && (el.matches('a, button, label, [role=button], [role=link]') ? el.innerText || '' : [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' '));
      const text = (own || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const r = el && el.getBoundingClientRect();
      out.push({
        type: 'a11y', rule: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, target: node.target.join(' ').slice(0, 120),
        el: { path: tags.join('>'), tag: el ? el.tagName.toLowerCase() : '', cls: el ? [...el.classList].slice(0, 2).map((c) => c.slice(0, 24)) : [], text, ident },
        box: r && r.width ? [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)] : null,
      });
    }
  }
  return out;
}

// True if the framework's dev error overlay is showing (checked before we hide it).
function devOverlayError() {
  if (document.querySelector('vite-error-overlay')) return true;
  const next = document.querySelector('nextjs-portal');
  if (next && next.shadowRoot && next.shadowRoot.querySelector('[data-nextjs-dialog], [data-nextjs-toast-errors], [data-issues-count]')) return true;
  const wp = document.getElementById('webpack-dev-server-client-overlay');
  return !!(wp && wp.style.display !== 'none');
}

// Storybook's error screen (story threw, or no such story): its message, else null.
function storybookError() {
  if (!document.body.classList.contains('sb-show-errordisplay')) return null;
  const el = document.querySelector('#error-message') || document.querySelector('.sb-errordisplay');
  return ((el && el.innerText) || 'unknown error').trim().split('\n')[0].slice(0, 200);
}

async function main() {
  const a = args();
  if (!a.url || !a.out) {
    console.error('Required: --url <base url> --out <dir>');
    process.exit(1);
  }
  const cfg = a.config && fs.existsSync(a.config) ? JSON.parse(fs.readFileSync(a.config, 'utf8')) : {};
  const routes = mergeRoutes(cfg.routes, typeof a.routes === 'string' ? a.routes.split(',').filter(Boolean) : []);
  const viewports = parseViewports(a.viewports) || cfg.viewports || DEFAULT_VIEWPORTS;
  const schemes = a.schemes ? a.schemes.split(',') : cfg.colorSchemes || ['light'];
  const mask = cfg.mask || [];
  const hide = [...DEV_OVERLAYS, ...(cfg.hide || [])];
  const extraCSS = `${STABILIZE_CSS}\n${hide.join(',')} { display: none !important; }\n${cfg.css || ''}`;
  const settleMs = Number(a.settle ?? cfg.settleMs ?? 300);
  const storageState = cfg.storageState && fs.existsSync(cfg.storageState) ? cfg.storageState : undefined;
  // "checks": false turns them all off; an object turns single checks off and ignores selectors.
  const checks = cfg.checks === false || a['no-checks'] ? null : { ...(cfg.checks || {}) };
  const only = typeof a.only === 'string' ? new Set(a.only.split(',').filter(Boolean)) : null;
  const clock = clockStart(cfg, a);
  let axeSource = null;
  if (checks && checks.a11y !== false) {
    try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js', { paths: [TOOLS_DIR] }), 'utf8'); } catch {
      console.error('note: axe-core not installed; accessibility checks skipped (rerun scripts/setup.sh)');
    }
  }

  fs.mkdirSync(a.out, { recursive: true });
  const browser = await chromium.launch();
  const manifest = [];

  for (const scheme of schemes) {
    for (const [vpName, vp] of Object.entries(viewports)) {
      const context = await browser.newContext({
        ...contextFor(vp, cfg),
        colorScheme: scheme,
        reducedMotion: 'reduce',
        locale: cfg.locale || 'en-US',
        timezoneId: cfg.timezone || 'UTC',
        storageState,
      });
      if (clock !== null) await context.clock.install({ time: clock });
      if (cfg.seedRandom !== false) await context.addInitScript(seedRandom, 0x5eed);
      for (const route of routes) {
        const file = `${route.name}__${vpName}${schemes.length > 1 ? `__${scheme}` : ''}.png`;
        if (only && !only.has(file)) continue;
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e.message || e).split('\n')[0]));
        const url = new URL(route.path, a.url).toString();
        const entry = { route: route.label || route.path, name: route.name, viewport: vpName, scheme, file, url };
        const figma = figmaFor(route, vpName, Object.keys(viewports)[0]);
        if (figma) entry.figma = figma;
        try {
          const resp = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
          entry.status = resp ? resp.status() : null;
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
          if (route.waitFor) await page.waitForSelector(route.waitFor, { timeout: 15000 });
          for (const act of route.actions || []) await runAction(page, act);
          await page.evaluate(() => document.fonts && document.fonts.ready);
          await page.waitForTimeout(settleMs);
          if (await page.evaluate(devOverlayError)) entry.devOverlayError = true;
          const sbError = await page.evaluate(storybookError);
          if (sbError) pageErrors.push(`Storybook couldn't render the story: ${sbError}`);
          await page.addStyleTag({ content: extraCSS });
          await page.screenshot({
            path: path.join(a.out, file),
            fullPage: route.fullPage ?? cfg.fullPage ?? true,
            animations: 'disabled',
            caret: 'hide',
            mask: [...mask, ...(route.mask || [])].map((s) => page.locator(s)),
          });
          const styles = await page.evaluate(snapshotStyles);
          fs.writeFileSync(path.join(a.out, file.replace(/\.png$/, '.styles.json')), JSON.stringify(styles));
          if (checks) {
            const d = vp.device && devices[vp.device];
            const opts = {
              mobile: d ? !!(d.isMobile || d.hasTouch) : /mobile|phone/i.test(vpName) || vp.width <= 480,
              ignore: [...(checks.ignore || []), ...mask, ...(route.mask || [])],
              ignoreRules: checks.ignoreRules || [],
              off: Object.fromEntries(Object.entries(checks).filter(([, v]) => v === false).map(([k]) => [k, true])),
            };
            const found = await page.evaluate(detectIssues, opts);
            if (axeSource) {
              try {
                await page.addScriptTag({ content: axeSource });
                found.issues.push(...(await page.evaluate(runAxe, opts)));
              } catch (e) { found.axeError = String(e.message || e).split('\n')[0]; }
            }
            fs.writeFileSync(path.join(a.out, file.replace(/\.png$/, '.issues.json')), JSON.stringify(found));
          }
        } catch (e) {
          entry.error = String(e.message || e).split('\n')[0];
          console.error(`! ${url} [${vpName}/${scheme}]: ${entry.error}`);
        }
        if (pageErrors.length) entry.pageErrors = pageErrors.slice(0, 3);
        manifest.push(entry);
        await page.close();
        const flag = entry.error ? 'x' : entry.status >= 400 ? `HTTP ${entry.status}` : '✓';
        console.error(`${flag} ${file}${entry.pageErrors || entry.devOverlayError ? ' (page errors)' : ''}`);
      }
      await context.close();
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(a.out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const failed = manifest.filter((m) => m.error).length;
  console.log(JSON.stringify({ out: a.out, captured: manifest.length - failed, failed }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
