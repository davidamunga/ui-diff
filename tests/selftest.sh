#!/usr/bin/env bash
# End-to-end self-test for the ui-diff scripts. Builds throwaway git repos from
# tests/fixtures, runs the real pipeline against them, and checks the results.
#
# Usage: tests/selftest.sh [--full] [--keep]
#   --full   also scaffold a real Vite + React app and a Storybook (needs network; adds ~1 min)
#   --keep   keep the temp dir for inspection (path is printed)
#
# The fast tier needs python3 (static file server), node, git. No network after the
# one-time tool install, nothing pushed anywhere, no GitHub calls.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
S="$HERE/../skills/ui-diff/scripts"
FIX="$HERE/fixtures"
FULL=0 KEEP=0
for a in "$@"; do
  case "$a" in --full) FULL=1 ;; --keep) KEEP=1 ;; *) echo "unknown option $a" >&2; exit 2 ;; esac
done

TMP="$(mktemp -d)"
BYSTANDER=""
cleanup() {
  [ -n "$BYSTANDER" ] && kill "$BYSTANDER" 2>/dev/null
  if [ "$KEEP" = 1 ]; then echo "kept: $TMP"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT

PASS=0 FAIL=0
expect() { if node "$HERE/expect.cjs" "$@"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi; }
check() { # check "<description>" <command...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  ✓ $desc"; PASS=$((PASS + 1)); else echo "  ✗ $desc"; FAIL=$((FAIL + 1)); fi
}
section() { echo; echo "▸ $*"; }
commit() { git -c user.name=selftest -c user.email=selftest@example.com commit -qm "$1"; }
port_closed() { ! curl -s -o /dev/null --max-time 1 "http://localhost:$1/"; }
no_extra_worktrees() { [ "$(git -C "$1" worktree list | wc -l | tr -d ' ')" = 1 ]; }
tree_clean() { [ -z "$(git -C "$1" status --porcelain)" ]; }

# Repo with fixture base on main and base+head overlay on a feature branch.
make_static_repo() {
  local dir="$1"
  mkdir -p "$dir" && cd "$dir" || exit 1
  git init -q -b main
  cp "$FIX/static-site/base/"* .
  git add -A && commit base
  git checkout -q -b feature
  cp "$FIX/static-site/head/"* .
  git add -A && commit "pricing refresh"
}

bash "$S/setup.sh" >/dev/null || { echo "tool setup failed"; exit 1; }

# ---------------------------------------------------------------------------------
section "spec: SKILL.md follows the Agent Skills spec (works across agents)"
node "$HERE/check-spec.cjs" "$HERE/../skills"
check "all spec rules pass" test $? = 0

section "unit: description splicing (post.cjs)"
cd "$TMP"
node -e '
const { spliceSection } = require(process.argv[1]);
const sec = "<!-- ui-diff:start -->\nNEW\n<!-- ui-diff:end -->";
const cases = [
  ["My PR text", "My PR text\n\n---\n\n" + sec],
  ["Intro\n\n<!-- ui-diff:start -->\nOLD\n<!-- ui-diff:end -->\n\nFooter", "Intro\n\n" + sec + "\n\nFooter"],
  ["", sec],
];
for (const [input, want] of cases) if (spliceSection(input, sec) !== want) { console.error(JSON.stringify(input)); process.exit(1); }
' "$S/post.cjs"
check "appends, replaces in place, keeps surrounding text" test $? = 0

section "unit: dev command detection (devcmd.cjs)"
mkdir -p "$TMP/dc/vite" "$TMP/dc/next" "$TMP/dc/static" "$TMP/dc/none"
echo '{"scripts":{"dev":"vite"},"devDependencies":{"vite":"6"}}' > "$TMP/dc/vite/package.json"
echo '{"scripts":{"dev":"next dev"},"dependencies":{"next":"15"}}' > "$TMP/dc/next/package.json"
touch "$TMP/dc/next/pnpm-lock.yaml"
touch "$TMP/dc/static/index.html"
check "vite + npm"   test "$(node "$S/devcmd.cjs" "$TMP/dc/vite")" = "npm run dev -- --port {port} --strictPort"
check "next + pnpm"  test "$(node "$S/devcmd.cjs" "$TMP/dc/next")" = "pnpm run dev -p {port}"
check "static html"  test "$(node "$S/devcmd.cjs" "$TMP/dc/static")" = "python3 -m http.server {port}"
check "nothing to run → error" bash -c "! node '$S/devcmd.cjs' '$TMP/dc/none'"

check "no lockfile is not an error under set -e (run.sh lockfile)" bash -c "set -euo pipefail; eval \"\$(grep '^lockfile()' '$S/run.sh')\"; l=\"\$(lockfile '$TMP')\"; [ -z \"\$l\" ]"

section "unit: dependency linking in a monorepo (linkdeps.cjs)"
# src: an app whose node_modules holds a registry package and a workspace link (@acme/ui -> packages/ui).
for r in src dst; do mkdir -p "$TMP/ld/$r/apps/web" "$TMP/ld/$r/packages/ui"; echo "$r" > "$TMP/ld/$r/packages/ui/index.js"; done
mkdir -p "$TMP/ld/src/apps/web/node_modules/@acme" "$TMP/ld/src/apps/web/node_modules/react"
ln -s ../../../../packages/ui "$TMP/ld/src/apps/web/node_modules/@acme/ui"
node "$S/linkdeps.cjs" "$TMP/ld/src" "$TMP/ld/dst" >/dev/null
check "workspace package resolves to the worktree's own source" test "$(cat "$TMP/ld/dst/apps/web/node_modules/@acme/ui/index.js")" = dst
check "registry packages are shared with the checkout" test "$(cd "$TMP/ld/dst/apps/web/node_modules/react" && pwd -P)" = "$(cd "$TMP/ld/src/apps/web/node_modules/react" && pwd -P)"

section "unit: Figma link parsing (figma-export.cjs)"
node -e '
const { parseFigmaUrl } = require(process.argv[1]);
const ok = [
  ["https://www.figma.com/design/AbC123/My-App?node-id=1-2&t=x", "AbC123", "1:2"],
  ["https://figma.com/file/KEY9/Old?node-id=12%3A34", "KEY9", "12:34"],
  ["https://www.figma.com/design/MAIN/branch/BR7/App?node-id=5-6", "BR7", "5:6"],
  ["https://www.figma.com/proto/P1/x?node-id=I1-2%3B3-4", "P1", "I1:2;3:4"],
];
for (const [u, key, id] of ok) {
  const r = parseFigmaUrl(u);
  if (r.fileKey !== key || r.nodeId !== id) { console.error(u, r); process.exit(1); }
}
for (const bad of ["https://www.figma.com/design/AbC123/My-App", "https://example.com/design/a/b?node-id=1-2", "nope", "https://www.figma.com/design/A/b?node-id=x-y"]) {
  try { parseFigmaUrl(bad); console.error("accepted", bad); process.exit(1); } catch {}
}
' "$S/figma-export.cjs"
check "file key + node id (1-2 → 1:2, encoded, branch, instance); rejects bad links" test $? = 0
check "no FIGMA_TOKEN → exit 2" bash -c "env -u FIGMA_TOKEN node '$S/figma-export.cjs' 'https://www.figma.com/design/A/b?node-id=1-2' --out '$TMP/x.png'; test \$? = 2"

section "unit: design vs implementation (compare.cjs)"
mkdir -p "$TMP/cmp"
cat > "$TMP/cmp/gen.cjs" <<'JS'
// design.png: 400×300 @1x. same.png: identical @2x plus sparse 1px noise.
// shifted.png: @2x, the blue button moved 60px right, page 60px taller with a footer.
const { need, writePng, blank } = require(process.argv[2] + '/lib.cjs');
need('pngjs');
function draw(scale, shift, extraH, noise) {
  const img = blank(400 * scale, (300 + extraH) * scale);
  const rect = (x, y, w, h, c) => {
    for (let yy = y * scale; yy < (y + h) * scale; yy++)
      for (let xx = x * scale; xx < (x + w) * scale; xx++) img.data.set([...c, 255], (yy * img.width + xx) * 4);
  };
  rect(0, 0, 400, 40, [17, 24, 39]);
  for (let r = 0; r < 4; r++) rect(40, 70 + r * 22, 300 - r * 40, 10, [75, 85, 99]);
  rect(50 + shift, 200, 120, 40, [37, 99, 235]);
  if (extraH) rect(0, 300 + extraH - 20, 400, 20, [17, 24, 39]); // footer below the frame
  if (noise) for (let i = 0; i < (img.width * img.height) / 200; i++) {
    const p = ((i * 7919) % (img.width * img.height)) * 4;
    img.data[p] = Math.max(0, img.data[p] - 60);
  }
  return img;
}
writePng(process.argv[3] + '/design.png', draw(1, 0, 0, false));
writePng(process.argv[3] + '/same.png', draw(2, 0, 0, true));
writePng(process.argv[3] + '/shifted.png', draw(2, 60, 60, false));
JS
node "$TMP/cmp/gen.cjs" "$S" "$TMP/cmp"
C="$TMP/cmp/out"
node "$S/compare.cjs" --design "$TMP/cmp/design.png" --actual "$TMP/cmp/same.png" --out "$C" > /dev/null
check "compare.cjs exits 0" test $? = 0
expect "$C/same.json" 'd.regions.length === 0 && d.compared.width === 400 && d.notes.length === 0' "same layout at 2× with pixel noise → nothing flagged"
node "$S/compare.cjs" --design "$TMP/cmp/design.png" --actual "$TMP/cmp/shifted.png" --out "$C" --name btn --figma "https://www.figma.com/design/A/b?node-id=1-2" > /dev/null
expect "$C/btn.json" 'd.regions.length >= 1 && d.regions.every((r) => r.y < 240 && r.y + r.height > 200) && d.regions.some((r) => r.x < 110) && d.regions.some((r) => r.x + r.width > 170)' "moved button is found where it was and where it is"
expect "$C/btn.json" 'd.regions.every((r) => r.zoom) && d.figma && has(d.notes.join(), "only the top 300px")' "zoom crops, figma link, height-mismatch note"
check "composite is design | implementation | diff wide" node -e '
const { readPng } = require(process.argv[1] + "/lib.cjs");
const c = readPng(process.argv[2]);
process.exit(c.width > 3 * 400 && c.height > 300 ? 0 : 1);' "$S" "$C/btn__composite.png"
check "zoom crop written" test -f "$C/zoom/btn__r1__actual.png"
node "$S/compare.cjs" --design "$TMP/cmp/design.png" --actual "$TMP/cmp/shifted.png" --out "$C" --name padded --fit pad > /dev/null
expect "$C/padded.json" 'd.compared.height === 360 && d.regions.some((r) => r.y + r.height >= 300)' "--fit pad compares the full height (extra length flagged)"

section "unit: Storybook story picking (stories.cjs)"
SBF="$FIX/storybook"
# pick <changed files...> → sorted story ids (fixture index.json files, sources read from the fixture)
pick() {
  printf '%s\n' "$@" > "$TMP/sb-changed.txt"
  node "$S/stories.cjs" --base "$SBF/index-base.json" --head "$SBF/index-head.json" --changed "$TMP/sb-changed.txt" \
    --root-head "$SBF" --out "$TMP/sb" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(r.stories.map((s)=>s.id).sort().join(",")+(r.unmatched.length?" ?"+r.unmatched.join(","):""))'
}
check "changed story file → its stories" test "$(pick src/components/Header.stories.tsx)" = "header--logged-in,header--logged-out"
check "same base name (Button.module.css) + importers (Card)" test "$(pick src/components/Button.module.css)" = "button--primary,button--secondary,card--default"
check "index.tsx counts as its folder name" test "$(pick src/components/Card/index.tsx)" = "card--default"
check "unimported file → stories in the same folder" test "$(pick src/components/Icon.tsx)" = "badge--default,button--primary,button--secondary,header--logged-in,header--logged-out"
check ".storybook/ change → every story, no docs entries" test "$(pick .storybook/preview.ts | tr ',' '\n' | wc -l | tr -d ' ')" = 6
check "unrelated file → nothing, reported as unmatched" test "$(pick src/lib/format.ts README.md)" = " ?src/lib/format.ts"
pick src/components/Badge.stories.tsx src/components/Header.stories.tsx > /dev/null
expect "$TMP/sb/capture-head.json" 'd.routes.some((r) => r.name === "badge--default") && !d.routes.some((r) => r.name === "header--logged-out")' "head config: new story in, base-only story out"
expect "$TMP/sb/capture-base.json" '!d.routes.some((r) => r.name === "badge--default") && d.routes.some((r) => r.name === "header--logged-out")' "base config: the reverse (diff.cjs then reports new / removed)"
expect "$TMP/sb/capture-head.json" 'd.routes[0].path.startsWith("/iframe.html?id=") && d.routes[0].path.endsWith("&viewMode=story") && d.viewports.desktop.width === 1024' "iframe URLs and the smaller story viewport"
check "--stories with wildcard" test "$(node "$S/stories.cjs" --base "$SBF/index-base.json" --head "$SBF/index-head.json" --stories 'button--*,card--default' --out "$TMP/sb" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).stories.map((s)=>s.id).join())')" = "button--primary,button--secondary,card--default"
check "Storybook 6 stories.json is read too" node -e 'const {parseIndex}=require(process.argv[1]);const s=parseIndex({v:3,stories:{"a--b":{id:"a--b",kind:"A",name:"B",importPath:"./src/A.stories.js"}}});if(s.length!==1||s[0].title!=="A"||s[0].importPath!=="src/A.stories.js")process.exit(1)' "$S/stories.cjs"
mkdir -p "$TMP/dc/sb-script" "$TMP/dc/sb-dir/.storybook"
echo '{"scripts":{"storybook":"storybook dev -p 6006"}}' > "$TMP/dc/sb-script/package.json"
echo '{"devDependencies":{"storybook":"10"}}' > "$TMP/dc/sb-dir/package.json"
touch "$TMP/dc/sb-dir/pnpm-lock.yaml"
check "storybook script + npm" test "$(node "$S/devcmd.cjs" "$TMP/dc/sb-script" --storybook)" = "npm run storybook -- -p {port} --ci"
check "storybook CLI + pnpm"  test "$(node "$S/devcmd.cjs" "$TMP/dc/sb-dir" --storybook)" = "pnpm exec storybook dev -p {port} --ci"

section "unit: possible-bug checks in the page (capture.cjs on tests/fixtures/checks)"
CK_PORT="$(python3 -c 'import socket; s = socket.socket(); s.bind(("", 0)); print(s.getsockname()[1])')"
python3 -m http.server "$CK_PORT" --directory "$FIX/checks" >/dev/null 2>&1 &
CK_PID=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://localhost:$CK_PORT/" && break; sleep 0.1; done
node "$S/capture.cjs" --url "http://localhost:$CK_PORT" --out "$TMP/ck" --routes / > /dev/null 2>&1
check "capture.cjs exits 0" test $? = 0
kill "$CK_PID" 2>/dev/null
# fx(type, text) → the issues of that type whose element text/ident contains text
# (expressions only: fx is bound by an arrow function wrapped around each check)
FX='((fx) => '
XF=')((t, s) => d.issues.filter((i) => i.type === t && (s === undefined || has(i.el.text + "|" + i.el.ident, s))))'
for vp in desktop mobile; do
  expect "$TMP/ck/home__$vp.issues.json" "$FX"' fx("textClipping", "Subscription details").length === 1 && fx("textClipping", "First line").length === 1'"$XF" "$vp: ellipsis and line-clamp truncation"
  expect "$TMP/ck/home__$vp.issues.json" "$FX"' fx("overlap").length === 1 && has(fx("overlap")[0].el.text + fx("overlap")[0].other.text, "Billed yearly")'"$XF" "$vp: overlapping paragraphs (and only those: hidden clamped lines don't count)"
  expect "$TMP/ck/home__$vp.issues.json" "$FX"' fx("offscreen").length === 1 && fx("offscreen", "Buy now").length === 1'"$XF" "$vp: control pushed out of its clipped row"
  expect "$TMP/ck/home__$vp.issues.json" "$FX"' fx("a11y").some((i) => i.rule === "button-name") && fx("a11y").some((i) => i.rule === "image-alt") && !fx("a11y").some((i) => i.rule === "color-contrast")'"$XF" "$vp: axe violations (button-name, image-alt; contrast left to the style diff)"
  expect "$TMP/ck/home__$vp.issues.json" "$FX"' !d.issues.some((i) => /Slide|Short line|Big title|screen readers|Skip to|Sticky|Email|Wide content/.test(i.el.text + (i.other ? i.other.text : "")) && i.type !== "a11y")'"$XF" "$vp: no false positives (carousel, scroll box, tight heading, sr-only, skip link, sticky bar, floating label)"
done
expect "$TMP/ck/home__mobile.issues.json" "$FX"' fx("pageOverflow").length === 1 && fx("pageOverflow")[0].detail.widest[0].cls[0] === "wide"'"$XF" "mobile: sideways scroll names the wide strip (not the scroll box)"
expect "$TMP/ck/home__mobile.issues.json" "$FX"' fx("tapTargets").length === 2 && !fx("tapTargets", "One").length && !fx("tapTargets", "inline link").length && !d.issues.some((i) => i.el.tag === "input" && i.type === "tapTargets")'"$XF" "mobile: crowded 14px targets flagged; padded nav, inline link, native checkbox exempt"
expect "$TMP/ck/home__desktop.issues.json" "$FX"' !fx("tapTargets").length && !fx("pageOverflow").length'"$XF" "desktop: no tap-target check, no sideways scroll"
printf '{"checks":{"a11y":false,"textClipping":false,"ignore":[".pushed"]}}' > "$TMP/ck.json"
python3 -m http.server "$CK_PORT" --directory "$FIX/checks" >/dev/null 2>&1 &
CK_PID=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://localhost:$CK_PORT/" && break; sleep 0.1; done
node "$S/capture.cjs" --url "http://localhost:$CK_PORT" --out "$TMP/ck2" --routes / --viewports "desktop:1280x800" --config "$TMP/ck.json" > /dev/null 2>&1
kill "$CK_PID" 2>/dev/null
expect "$TMP/ck2/home__desktop.issues.json" "$FX"' !fx("a11y").length && !fx("textClipping").length && !fx("offscreen").length && fx("overlap").length === 1'"$XF" "config: checks turned off and selectors ignored"

section "unit: frozen clock and seeded Math.random (capture.cjs on tests/fixtures/noise)"
python3 -m http.server "$CK_PORT" --directory "$FIX/noise" >/dev/null 2>&1 &
CK_PID=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://localhost:$CK_PORT/clock.html" && break; sleep 0.1; done
CLK=(--url "http://localhost:$CK_PORT" --routes /clock.html --viewports "desktop:800x600" --no-checks)
node "$S/capture.cjs" "${CLK[@]}" --out "$TMP/clk1" --time "$(node -e 'console.log(Date.parse("2001-02-03T04:05:00Z"))')" > /dev/null 2>&1
node "$S/capture.cjs" "${CLK[@]}" --out "$TMP/clk2" > /dev/null 2>&1
printf '{"clock":false,"seedRandom":false}' > "$TMP/clk-off.json"
node "$S/capture.cjs" "${CLK[@]}" --out "$TMP/clk3" --config "$TMP/clk-off.json" > /dev/null 2>&1
kill "$CK_PID" 2>/dev/null
TXT='d.elements.map((e) => e.text).join("|")'
expect "$TMP/clk1/clock-html__desktop.styles.json" "has($TXT, \"now 2001-02-03T04:05\")" "--time sets the page clock"
check "same seed → same Math.random values on two loads" test "$(node -e 'const t=(f)=>require(f).elements.map((e)=>e.text).find((x)=>x.startsWith("rand"));console.log(t(process.argv[1])===t(process.argv[2]))' "$TMP/clk1/clock-html__desktop.styles.json" "$TMP/clk2/clock-html__desktop.styles.json")" = true
check '"clock": false and "seedRandom": false leave the real clock and Math.random alone' test "$(node -e 'const t=(f,p)=>require(f).elements.map((e)=>e.text).find((x)=>x.startsWith(p));const [a,b]=process.argv.slice(1);console.log(t(b,"now")!==t(a,"now")&&t(b,"rand")!==t(a,"rand"))' "$TMP/clk1/clock-html__desktop.styles.json" "$TMP/clk3/clock-html__desktop.styles.json")" = true

section "unit: changed files → routes (routes.cjs, every framework convention)"
node "$HERE/routes-unit.cjs" "$S" "$FIX/routes" > "$TMP/routes-unit.out" 2>&1
cat "$TMP/routes-unit.out"
PASS=$((PASS + $(grep -c '✓' "$TMP/routes-unit.out"))); FAIL=$((FAIL + $(grep -c '✗' "$TMP/routes-unit.out")))
grep -q '✓' "$TMP/routes-unit.out" || { echo "  ✗ routes-unit.cjs didn't run"; FAIL=$((FAIL + 1)); }
RT="$FIX/routes/next-app"
check "--print gives a comma list" test "$(echo src/components/Button.tsx | node "$S/routes.cjs" --root "$RT" --changed - --print)" = "/pricing"
check "--log explains picks and dynamic routes on stderr" bash -c "echo src/components/Button.tsx | node '$S/routes.cjs' --root '$RT' --changed - --log 2>&1 >/dev/null | grep -q 'blog/\[slug\] needs an example'"

# ---------------------------------------------------------------------------------
section "e2e: static site — style changes, new page, unchanged page"
REPO="$TMP/static"
make_static_repo "$REPO"
# Something already running that the run must not touch.
python3 -m http.server 0 >/dev/null 2>&1 &
BYSTANDER=$!
bash "$S/run.sh" --routes "/,/pricing.html,/about.html,/new.html" > "$TMP/static.out" 2> "$TMP/static.err"
check "run.sh exits 0" test $? = 0
R="$REPO/.ui-diff/report"
expect "$R/results.json" 'd.summary.changed === 4 && d.summary.added === 2 && d.summary.unchanged === 2 && d.summary.error === 0' "4 changed, 2 new, 2 unchanged, 0 errors"
expect "$R/results.json" 'item(d, "new-html__desktop.png").status === "added"' "page missing on base (404) is reported as new"
expect "$R/results.json" 'item(d, "about-html__desktop.png").status === "unchanged"' "page that doesn't use the changed CSS is unchanged"
expect "$R/results.json" 'item(d, "pricing-html__desktop.png").regions.some((r) => r.zoom)' "changed page has zoomed regions"
expect "$R/results.json" 'd.items.flatMap((i) => i.regions || []).filter((r) => r.zoom).every((r) => /__flip\.png$/.test(r.zoom.flip))' "every zoomed region has an animated flip"
FLIP="$(node -e 'const r=require(process.argv[1]);console.log(r.items.find((i)=>i.file==="pricing-html__desktop.png").regions[0].zoom.flip)' "$R/results.json")"
node "$HERE/apng.cjs" "$R/$FLIP" > "$TMP/flip.json"
expect "$TMP/flip.json" 'd.frames === 2 && d.plays === 0 && d.chunks.join() === "IHDR,acTL,fcTL,IDAT,fcTL,fdAT,IEND"' "flip is an APNG: 2 frames, loops forever"
expect "$TMP/flip.json" 'd.seqOk && d.crcOk && d.framesOk && d.delays.join() === "1200,1200"' "flip: sequence numbers, CRCs, frame bounds, 1.2s holds"
expect "$TMP/flip.json" 'd.size < 300000' "flip is small"
expect "$R/measured.md" 'has(d, "`padding`: 8px 14px → 12px 20px")' "measures padding change (as shorthand)"
expect "$R/measured.md" 'has(d, "`border-radius`: 4px → 12px")' "measures radius change"
expect "$R/measured.md" 'has(d, "`color`: #2563eb → #9ca3af")' "measures color change in hex"
expect "$R/measured.md" 'has(d, "copy: \"$12/mo\" → \"$10/mo, billed yearly\"")' "detects copy change"
expect "$R/measured.md" 'has(d, "contrast 2.54:1") && has(d, "(was 5.17:1)")' "flags new contrast failure with previous ratio"
expect "$R/measured.md" 'has(d, "contrast 1.92:1") && has(d, "Faint helper text")' "flags contrast on a brand-new page"
expect "$R/measured.md" '!has(d, "padding-top")' "no per-side padding noise"
expect "$R/results.json" '((p) => ["pageOverflow", "textClipping", "tapTargets", "a11y"].every((t) => p.includes(t)))(item(d, "pricing-html__mobile.png").issues.new.map((x) => x.type))' "head's new problems found on mobile: sideways scroll, clipped label, small tap targets, axe"
expect "$R/results.json" '((p) => p.some((x) => x.rule === "button-name") && p.some((x) => x.type === "textClipping") && !p.some((x) => x.type === "tapTargets" || x.type === "pageOverflow"))(item(d, "pricing-html__desktop.png").issues.new)' "desktop: clipped label + unnamed button; no tap targets or sideways scroll"
expect "$R/results.json" '((i) => i.existing >= 1 && !i.new.some((x) => x.rule === "html-has-lang"))(item(d, "pricing-html__mobile.png").issues)' "pre-existing missing lang isn't new, though the page's copy changed"
expect "$R/results.json" '["home__desktop.png", "home__mobile.png"].every((f) => item(d, f).issues.new.length === 0 && item(d, f).issues.existing >= 2)' "base's own problems (img without alt) are not reported as new"
expect "$R/results.json" 'item(d, "about-html__desktop.png").issues.new.length === 0' "unchanged page: nothing new"
expect "$R/results.json" 'item(d, "new-html__desktop.png").issues.existing === 0 && item(d, "new-html__desktop.png").issues.new.some((x) => x.rule === "html-has-lang")' "page only on head: all its problems are new"
expect "$R/results.json" 'item(d, "pricing-html__mobile.png").issues.new.filter((x) => x.type !== "a11y").every((x) => x.zoom)' "every new layout problem has a zoom crop"
check "zoom crop written" test -f "$R/$(node -e 'console.log(require(process.argv[1]).items.find((i) => i.file === "pricing-html__mobile.png").issues.new[0].zoom)' "$R/results.json")"
expect "$R/measured.md" 'd.indexOf("Possible problems") < d.indexOf("`padding`") && has(d, "page scrolls sideways") && has(d, "text cut off: small \"Most popular\"")' "measured.md leads with possible problems"
expect "$R/run.json" 'd.head.dirty === false && d.viewports.join() === "desktop,mobile"' "run.json: clean head, desktop + mobile"
PORTS="$(node -e 'const r=require(process.argv[1]);console.log(r.ports.base, r.ports.head)' "$R/run.json")"
for p in $PORTS; do check "server on :$p was stopped" port_closed "$p"; done
check "unrelated server still running" kill -0 "$BYSTANDER"
check "temporary worktree removed" no_extra_worktrees "$REPO"
check "working tree untouched" tree_clean "$REPO"
check ".ui-diff/ ignored locally" grep -qxF '.ui-diff/' "$REPO/.git/info/exclude"

section "e2e: flow vs visual tags on each animation (stylediff.cjs + annotate.cjs)"
expect "$R/results.json" '((f) => f.kind === "flow" && f.changes.some((c) => c === "New link \"Share\" → /pricing.html#share"))(item(d, "pricing-html__desktop.png").flow)' "new Share link on /pricing.html → flow change, with its target"
expect "$R/results.json" 'item(d, "home__desktop.png").flow.kind === "visual"' "style-only change on / → visual only"
expect "$R/results.json" 'item(d, "new-html__desktop.png").flow.changes.join() === "New page"' "page only on head → flow change: new page"
expect "$R/results.json" 'd.items.flatMap((i) => i.regions || []).filter((r) => r.zoom).every((r) => r.annotation && ["flow", "visual"].includes(r.annotation.kind) && r.annotation.note && r.annotation.source === "auto")' "every animated area has an automatic tag and note"
expect "$R/results.json" 'item(d, "pricing-html__desktop.png").regions.some((r) => r.annotation.kind === "flow" && /Share|Save|button/.test(r.annotation.note))' "the area holding the new controls is tagged flow"
expect "$R/measured.md" 'has(d, "🔀 flow: New link \"Share\"")' "measured.md lists the flow changes"
check "annotate.cjs logged nothing" test ! -s "$REPO/.ui-diff/annotate.log"
FID="$(node "$S/annotate.cjs" --report "$R" --list | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(l.find((r)=>r.kind==="flow"&&r.id.startsWith("pricing-html__desktop")).id)')"
printf '{ "%s": { "note": "Cards gain share and save actions" }, "/pricing.html": "Pro card highlighted", "/": { "kind": "flow", "note": "Forced flow" } }\n' "$FID" > "$TMP/notes.json"
node "$S/annotate.cjs" --report "$R" --notes "$TMP/notes.json" > "$TMP/ann.json"
check "annotate.cjs with a notes file exits 0" test $? = 0
expect "$R/results.json" '((r) => r.annotation.source === "agent" && r.annotation.kind === "flow" && r.annotation.note === "Cards gain share and save actions" && r.annotation.auto.note)(d.items.flatMap((i) => (i.regions || []).map((r, n) => [i.file.replace(/\.png$/, "") + "__r" + (n + 1), r])).find(([id]) => id === "'"$FID"'")[1])' "region note wins, keeps the automatic one alongside"
expect "$R/results.json" 'd.items.filter((i) => i.route === "/pricing.html" && i.status === "changed").flatMap((i) => i.regions.filter((r) => r.zoom)).every((r) => r.annotation.kind === "flow" ? r.annotation.note !== "Pro card highlighted" : r.annotation.note === "Pro card highlighted")' "a bare route note reaches visual areas only, never hides a flow note"
expect "$R/results.json" 'd.items.filter((i) => i.route === "/" && i.status === "changed").flatMap((i) => i.regions.filter((r) => r.zoom)).every((r) => r.annotation.kind === "flow")' "kind in a notes entry re-tags the areas"
node "$HERE/apng.cjs" "$R/$FLIP" > "$TMP/flip2.json"
expect "$TMP/flip2.json" 'd.frames === 2 && d.seqOk && d.crcOk && d.framesOk && d.size < 300000' "annotated flip is still a valid, small APNG"
echo '{ "x": { "kind": "maybe" } }' > "$TMP/bad-notes.json"
node "$S/annotate.cjs" --report "$R" --notes "$TMP/bad-notes.json" > /dev/null 2> "$TMP/bad-notes.err"
check "bad kind in notes → exits non-zero" test $? != 0
expect "$TMP/bad-notes.err" 'has(d, "must be a string or")' "explains the notes format"
node "$S/comment.cjs" --report "$R" --auto-summary --out "$TMP/flow-comment.md"
expect "$TMP/flow-comment.md" 'has(d, "🔀 **Flow change** · Cards gain share and save actions") && has(d, "Visual only · Pro card highlighted")' "comment shows each area's tag and note"
expect "$TMP/flow-comment.md" 'has(d, "**🔀 Flow changes**") && has(d, "`/pricing.html` — New link \"Share\"")' "automatic summary lists flow changes by route"
node "$S/annotate.cjs" --report "$R" > /dev/null # back to automatic notes for the sections below

section "e2e: local review page (viewer.cjs)"
check "run.sh prints the review page path" grep -qF "$R/index.html" "$TMP/static.err"
expect "$R/index.html" 'has(d, "<title>UI diff</title>") && !/<(script|link)[^>]+(src|href)="(https?:)?\/\//.test(d)' "self-contained (no external scripts or styles)"
node -e '
const fs = require("fs"), path = require("path"), r = process.argv[1];
const html = fs.readFileSync(path.join(r, "index.html"), "utf8");
const srcs = [...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
if (!srcs.length || srcs.some((s) => /^(\/|https?:)/.test(s) || !fs.existsSync(path.join(r, s)))) process.exit(1);
' "$R"
check "every image is a relative path that exists" test $? = 0
node -e '
const fs = require("fs"), path = require("path"), r = process.argv[1];
const html = fs.readFileSync(path.join(r, "index.html"), "utf8");
const changed = require(path.join(r, "results.json")).items.filter((i) => i.status === "changed");
if (!changed.length || changed.some((i) => !html.includes(`data-file="${i.file}"`) || !html.includes(`diff/${i.file}`))) process.exit(1);
' "$R"
check "includes every changed item (with its diff image)" test $? = 0
expect "$R/index.html" 'has(d, "after/new-html__desktop.png") && has(d, "No visual change (2)") && has(d, "class=\"stage\"")' "new page, unchanged list and slider present"
expect "$R/index.html" 'has(d, "class=\"problems\"") && has(d, "issues/pricing-html__mobile__p1.png") && has(d, "possible problems")' "possible problems shown with their zooms"
printf '**What changed**\n- Buttons got `rounder`\n' > "$R/summary.md"
node "$S/viewer.cjs" --report "$R" > /dev/null
expect "$R/index.html" 'has(d, "<strong>What changed</strong>") && has(d, "<code>rounder</code>")' "summary.md rendered at the top"
rm -f "$R/summary.md"

section "e2e: comment rendering"
node "$S/comment.cjs" --report "$R" --base-url "https://github.com/acme/demo/blob/ui-diff-assets/pr-1/abc1234" --out "$TMP/comment.md"
expect "$TMP/comment.md" 'd.startsWith("<!-- ui-diff:start -->") && d.trim().endsWith("<!-- ui-diff:end -->")' "wrapped in markers"
expect "$TMP/comment.md" 'has(d, "Pages not listed were not checked")' "states coverage"
expect "$TMP/comment.md" 'has(d, "pr-1/abc1234/zoom/") && has(d, "?raw=true")' "image URLs use the published prefix"
expect "$TMP/comment.md" 'has(d, "🆕 `/new.html`")' "new page section"
expect "$TMP/comment.md" 'has(d, "<summary>Measured changes</summary>")' "measured changes section"
expect "$TMP/comment.md" 'has(d, "pr-1/abc1234/'"$FLIP"'?raw=true") && d.indexOf("__flip.png") < d.indexOf("<summary>Before | After (still)</summary>")' "animated flips lead, still pairs collapsed after"
node "$S/comment.cjs" --report "$R" --no-animate --out "$TMP/comment-still.md"
expect "$TMP/comment-still.md" '!has(d, "__flip.png") && !has(d, "(still)") && has(d, "| Before | After |")' "--no-animate: still pairs only"
expect "$R/index.html" 'has(d, "'"$FLIP"'") && has(d, "trio four")' "review page shows the animation too"
expect "$TMP/comment.md" 'has(d, "possible problems</sub>") && has(d, "**⚠️ Possible problems**") && has(d, "pr-1/abc1234/issues/pricing-html__mobile__p1.png?raw=true")' "possible problems: count line, per-page list, zoom images"
expect "$TMP/comment.md" 'd.split("### `/pricing.html` — mobile")[1].indexOf("Possible problems") < d.split("### `/pricing.html` — mobile")[1].indexOf("| Before | After |")' "problems sit at the top of the item"

section "e2e: vs design section (base screenshot standing in for the Figma frame)"
node "$S/compare.cjs" --design "$REPO/.ui-diff/shots/before/pricing-html__desktop.png" --actual "$REPO/.ui-diff/shots/after/pricing-html__desktop.png" \
  --out "$R/design" --name pricing-html__desktop --label "/pricing.html — desktop" --figma "https://www.figma.com/design/A/b?node-id=1-2" > /dev/null
check "compare.cjs exits 0 on real screenshots" test $? = 0
expect "$R/design/pricing-html__desktop.json" 'd.regions.length >= 1 && d.compared.width === 1440' "real restyle shows up as boxed areas"
node "$S/comment.cjs" --report "$R" --base-url "https://github.com/acme/demo/blob/ui-diff-assets/pr-1/abc1234" --out "$TMP/comment-design.md"
expect "$TMP/comment-design.md" 'has(d, "### 📐 vs design") && has(d, "pr-1/abc1234/design/pricing-html__desktop__composite.png") && has(d, "[Figma frame](https://www.figma.com/design/A/b?node-id=1-2)")' "comment gets a vs design section with published image URLs"
expect "$TMP/comment.md" '!has(d, "vs design")' "no vs design section without compare results"

section "e2e: publishing to the assets branch (local bare remote)"
git init -q --bare "$TMP/remote.git"
git -C "$REPO" remote add origin "$TMP/remote.git"
P1="$(cd "$REPO" && UI_DIFF_REPO=acme/demo bash "$S/publish.sh" "$R" 1 abc1234 2>/dev/null)"
check "prints the URL prefix only" test "$P1" = "https://github.com/acme/demo/blob/ui-diff-assets/pr-1/abc1234"
(cd "$REPO" && UI_DIFF_REPO=acme/demo bash "$S/publish.sh" "$R" 2 def5678 >/dev/null 2>&1)
check "branch stays a single commit" test "$(git --git-dir="$TMP/remote.git" rev-list --count ui-diff-assets)" = 1
check "keeps earlier PRs' images" git --git-dir="$TMP/remote.git" cat-file -e "ui-diff-assets:pr-1/abc1234/diff/pricing-html__desktop.png"
check "adds the new PR's images" git --git-dir="$TMP/remote.git" cat-file -e "ui-diff-assets:pr-2/def5678/diff/pricing-html__desktop.png"
check "user's branch untouched" test "$(git -C "$REPO" branch --show-current)" = feature

section "e2e: pruning the assets branch (prune.sh)"
assets_sha() { git --git-dir="$TMP/remote.git" rev-parse ui-diff-assets; }
(cd "$REPO" && UI_DIFF_REPO=acme/demo bash "$S/prune.sh" 1 >/dev/null 2>&1)
check "prune.sh exits 0" test $? = 0
check "removes the closed PR's images" bash -c "! git --git-dir='$TMP/remote.git' cat-file -e ui-diff-assets:pr-1"
check "keeps other PRs' images" git --git-dir="$TMP/remote.git" cat-file -e "ui-diff-assets:pr-2/def5678/diff/pricing-html__desktop.png"
check "branch stays a single commit" test "$(git --git-dir="$TMP/remote.git" rev-list --count ui-diff-assets)" = 1
BEFORE="$(assets_sha)"
(cd "$REPO" && UI_DIFF_REPO=acme/demo bash "$S/prune.sh" 99 >/dev/null 2>&1)
check "PR with no images → exits 0 without pushing" test $? = 0 -a "$(assets_sha)" = "$BEFORE"
(cd "$REPO" && UI_DIFF_REPO=acme/demo UI_DIFF_BRANCH=no-such-branch bash "$S/prune.sh" 2 >/dev/null 2>&1)
check "no assets branch → exits 0" test $? = 0
(cd "$TMP" && UI_DIFF_REPO=acme/demo UI_DIFF_REMOTE="$TMP/remote.git" bash "$S/prune.sh" 2 >/dev/null 2>&1)
check "works outside a checkout with UI_DIFF_REMOTE" bash -c "! git --git-dir='$TMP/remote.git' cat-file -e ui-diff-assets:pr-2"

section "unit: automatic summary (comment.cjs --auto-summary)"
node "$S/comment.cjs" --report "$R" --auto-summary --out "$TMP/auto.md"
expect "$TMP/auto.md" 'has(d, "Automatic summary") && has(d, "**What changed**")' "labelled as automatic"
expect "$TMP/auto.md" 'has(d, "`/pricing.html` (desktop, mobile) — ") && has(d, "text change")' "one line per route across viewports, with measured facts"
expect "$TMP/auto.md" 'has(d, "🆕 `/new.html` — new page (desktop, mobile)") && !has(d.split("<sub>**")[0], "HTTP 404")' "new page (its base 404 isn't flagged)"
expect "$TMP/auto.md" 'has(d, "**Worth a look**") && has(d, "contrast 2.54:1") && has(d, "(was 5.17:1)")' "new contrast failures under worth a look"
expect "$TMP/auto.md" '((w) => has(w[0], "page scrolls sideways") || has(w[0], "text cut off"))(d.split("**Worth a look**")[1].split("\n").filter((l) => l.startsWith("- ")))' "worth a look leads with layout problems"
expect "$TMP/auto.md" 'has(d, "2 tap targets under 24×24px") && has(d, "— `/pricing.html` (mobile)") && !has(d, "image-alt")' "problems grouped across viewports; base's own problems left out"
expect "$TMP/auto.md" 'd.split("<sub>**")[0].split("contrast 2.54:1").length === 2 && has(d, "— `/`, `/pricing.html` (desktop, mobile)")' "a shared-header issue is one line across pages"
expect "$TMP/auto.md" 'has(d, "contrast 1.92:1 (needs 4.5:1), #bbbbbb on #ffffff: p \"Faint helper text\"")' "new-page contrast is listed too"
expect "$TMP/auto.md" '!has(d, "/about.html` (")' "unchanged pages aren't listed as changed"
echo "**Hand-written**" > "$TMP/summary.md"
node "$S/comment.cjs" --report "$R" --auto-summary --summary "$TMP/summary.md" --out "$TMP/both.md"
expect "$TMP/both.md" 'has(d, "Hand-written") && !has(d, "Automatic summary")' "--summary wins over --auto-summary"

section "unit: description mode uses the REST API (post.cjs, stub gh)"
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'EOF'
#!/usr/bin/env bash
# Stand-in for gh: logs each call; answers as if the PR has no ui-diff comment yet.
echo "$*" >> "$GH_LOG"
for a in "$@"; do case "$a" in body=@*) cp "${a#body=@}" "$GH_LOG.body" ;; esac; done
case "$*" in
  *--paginate*) ;;
  "pr view"*) echo "Original PR text" ;;
  "pr comment"*) echo "https://github.com/acme/demo/pull/$3#issuecomment-1" ;;
  *PATCH*) echo "https://github.com/acme/demo/pull/7" ;;
esac
EOF
chmod +x "$TMP/bin/gh"
export GH_LOG="$TMP/gh.log"
PATH="$TMP/bin:$PATH" node "$S/post.cjs" --pr 7 --body "$TMP/comment.md" --mode description > "$TMP/post.out"
check "post.cjs exits 0" test $? = 0
expect "$GH_LOG" 'has(d, "api -X PATCH repos/{owner}/{repo}/pulls/7")' "edits the description via REST"
expect "$GH_LOG.body" 'd.startsWith("Original PR text\n\n---\n\n<!-- ui-diff:start -->")' "keeps the existing description"

section "e2e: GitHub Action (action/ci.sh) with a fake PR event, shallow checkout, stub gh"
git -C "$REPO" push -q origin main feature
git clone -q --depth 1 --branch feature "file://$TMP/remote.git" "$TMP/ci"
BASE_SHA="$(git -C "$REPO" rev-parse main)" HEAD_SHA="$(git -C "$REPO" rev-parse feature)"
event() { # event <action> <head repo>
  printf '{"action":"%s","number":7,"pull_request":{"number":7,"base":{"sha":"%s"},"head":{"sha":"%s","repo":{"full_name":"%s"}}}}' \
    "$1" "$BASE_SHA" "$HEAD_SHA" "$2" > "$TMP/event.json"
}
ci() { # ci <stderr file> [VAR=value...]
  local err="$1"; shift
  (cd "$TMP/ci" && env PATH="$TMP/bin:$PATH" GITHUB_EVENT_NAME=pull_request GITHUB_EVENT_PATH="$TMP/event.json" \
    GITHUB_REPOSITORY=acme/demo GITHUB_OUTPUT="$TMP/gh-output" GITHUB_STEP_SUMMARY="$TMP/gh-summary" \
    UI_DIFF_REMOTE="file://$TMP/remote.git" GH_TOKEN=dummy UI_DIFF_VIEWPORTS="desktop:1280x800" "$@" \
    bash "$HERE/../action/ci.sh" > "$err.out" 2> "$err")
}
: > "$GH_LOG"
event synchronize acme/demo
ci "$TMP/ci.err" UI_DIFF_ROUTES="/,/pricing.html"
check "ci.sh exits 0" test $? = 0
check "unshallowed the checkout to find the merge-base" test "$(git -C "$TMP/ci" rev-parse --is-shallow-repository)" = false
expect "$TMP/gh-output" 'has(d, "skipped=false") && has(d, "changed=2") && has(d, "errors=0")' "sets counts as outputs"
expect "$TMP/gh-output" 'has(d, "comment-url=https://github.com/acme/demo/pull/7#issuecomment-1")' "sets the comment URL output"
check "published PR #7's images at the head sha" git --git-dir="$TMP/remote.git" cat-file -e "ui-diff-assets:pr-7/${HEAD_SHA:0:7}/diff/pricing-html__desktop.png"
check "published the animated flips" test -n "$(git --git-dir="$TMP/remote.git" ls-tree -r --name-only ui-diff-assets "pr-7/${HEAD_SHA:0:7}/zoom/" | grep '__flip\.png$')"
expect "$GH_LOG" 'has(d, "pr comment 7 --body-file")' "posts the comment"
expect "$TMP/ci/.ui-diff/comment.md" 'has(d, "Automatic summary") && has(d, "acme/demo/blob/ui-diff-assets/pr-7/")' "comment has the automatic summary and published images"
expect "$TMP/ci.err.out" 'has(d, "::add-mask::")' "masks the git auth header"

: > "$GH_LOG"
event synchronize someone/fork
ci "$TMP/ci-fork.err" UI_DIFF_ROUTES="/"
check "fork PR → exits 0" test $? = 0
expect "$TMP/ci-fork.err" 'has(d, "comes from a fork") && has(d, "skipping")' "explains why it skipped"
expect "$TMP/gh-output" 'has(d, "skipped=true")' "sets skipped=true"
check "fork PR → no gh calls" test ! -s "$GH_LOG"

event synchronize acme/demo
: > "$TMP/gh-output"
ci "$TMP/ci-auto.err"
check "no routes given → picks them from the diff, exits 0" test $? = 0
expect "$TMP/ci-auto.err" '(() => { const l = (d.split("picked from the diff: ")[1] || "").split("\n")[0].split(","); return ["/", "/pricing.html", "/new.html"].every((r) => l.includes(r)) && !l.includes("/about.html"); })()' "logs the routes it picked (not the untouched page)"
expect "$TMP/ci-auto.err" 'has(d, "routes from the diff (html):") && has(d, "imports style.css")' "logs why each route was picked"
expect "$TMP/gh-output" 'has(d, "added=1") && has(d, "errors=0")' "captures them (new page reported as new)"
ci "$TMP/ci-noroutes.err" UI_DIFF_AUTO_ROUTES=false
check "auto-routes off, no routes → fails" test $? != 0
expect "$TMP/ci-noroutes.err" 'has(d, "no routes to capture") && has(d, "routes")' "says how to give routes"
# A docs-only PR: nothing visual, so it's skipped rather than failed.
(cd "$REPO" && git checkout -q -b docs-only && echo "# notes" > CHANGES.md && git add CHANGES.md && commit "docs" && git push -q origin docs-only && git checkout -q feature)
git -C "$TMP/ci" fetch -q origin docs-only
printf '{"action":"synchronize","number":8,"pull_request":{"number":8,"base":{"sha":"%s"},"head":{"sha":"%s","repo":{"full_name":"acme/demo"}}}}' \
  "$HEAD_SHA" "$(git -C "$REPO" rev-parse docs-only)" > "$TMP/event.json"
ci "$TMP/ci-docs.err"
check "docs-only PR → skipped, exits 0" test $? = 0
expect "$TMP/ci-docs.err" 'has(d, "none of the changed files affect a page")' "explains why it skipped"
ci "$TMP/ci-badmode.err" UI_DIFF_MODE=bogus
check "unknown mode → fails" test $? != 0

event closed acme/demo
ci "$TMP/ci-closed.err"
check "closed PR → exits 0 (prunes, no routes needed)" test $? = 0
check "closed PR's images removed" bash -c "! git --git-dir='$TMP/remote.git' cat-file -e ui-diff-assets:pr-7"

section "e2e: design review gate (require-approval, mode approve, stateful stub gh)"
# The stub keeps the PR head, who can write, comments and statuses in $GHS/state.json.
GHS="$TMP/ghs"; mkdir -p "$GHS" "$TMP/bin-review"
printf '#!/usr/bin/env bash\nexec node "%s" "$@"\n' "$HERE/gh-stub.cjs" > "$TMP/bin-review/gh"
chmod +x "$TMP/bin-review/gh"
echo "{\"head\":\"$HEAD_SHA\",\"perms\":{\"alice\":\"write\",\"mo\":\"maintain\",\"bob\":\"read\"}}" > "$GHS/state.json"
RPATH="$TMP/bin-review:$PATH"
set_head() { node -e 'const fs=require("fs"),f=process.argv[1],s=require(f); s.head=process.argv[2]; fs.writeFileSync(f, JSON.stringify(s))' "$GHS/state.json" "$1"; }
# Latest ui-diff/design-review status for a sha, and the comment body, as files for expect.
review_status() { node -e 'const s=require(process.argv[1]); console.log(JSON.stringify((s.statuses[process.argv[2]]||[]).find((x) => x.context === "ui-diff/design-review") || {}))' "$GHS/state.json" "$1" > "$TMP/rs.json"; }
comment_body() { node -e 'const s=require(process.argv[1]); process.stdout.write(Object.values(s.comments)[0].body)' "$GHS/state.json" > "$TMP/rc.md"; }
pr_event() { # pr_event <action> <head sha> [labels json] [label name] [sender]
  node -e 'const [a, sha, base, labels, label, sender] = process.argv.slice(1);
    console.log(JSON.stringify({ action: a, number: 8, sender: { login: sender }, label: label ? { name: label } : undefined,
      pull_request: { number: 8, base: { sha: base }, head: { sha, repo: { full_name: "acme/demo" } }, labels: JSON.parse(labels) } }))' \
    "$1" "$2" "$BASE_SHA" "${3:-[]}" "${4:-}" "${5:-alice}" > "$TMP/event.json"
}
tick_event() { # tick_event <sender> x|' ': issue_comment edited, the stored comment's box set to that
  node -e 'const fs = require("fs"); const f = process.argv[1], s = require(f), c = Object.values(s.comments)[0];
    const [sender, to, out] = process.argv.slice(2);
    const set = (v) => c.body.replace(/^- \[[ xX]\] \*\*Design approved\*\*/m, (l) => l.replace(/\[[ xX]\]/, `[${v}]`));
    const e = { action: "edited", sender: { login: sender }, issue: { number: 8, pull_request: {} },
      comment: { id: c.id, html_url: c.html_url, user: c.user, body: set(to) }, changes: { body: { from: set(to === "x" ? " " : "x") } } };
    fs.writeFileSync(out, JSON.stringify(e));
    c.body = e.comment.body; fs.writeFileSync(f, JSON.stringify(s)); // the edit lands before the webhook' \
    "$GHS/state.json" "$1" "$2" "$TMP/event.json"
}
approve() { ci "$TMP/ap.err" PATH="$RPATH" GH_STATE="$GHS" UI_DIFF_MODE=approve; }
posts() { grep -c 'statuses/' "$GHS/calls.log" 2>/dev/null || true; }

pr_event synchronize "$HEAD_SHA"
ci "$TMP/rv-none.err" PATH="$RPATH" GH_STATE="$GHS" UI_DIFF_ROUTES="/about.html" UI_DIFF_REQUIRE_APPROVAL=true
check "no visual changes → ci.sh exits 0" test $? = 0
review_status "$HEAD_SHA"
expect "$TMP/rs.json" 'd.state === "success" && d.description === "No visual changes" && has(d.target_url, "#issuecomment-")' "no visual changes → success, linked to the comment"
comment_body
expect "$TMP/rc.md" '!has(d, "Design approved") && !has(d, "ui-diff:review")' "no approval box when nothing changed"

pr_event synchronize "$HEAD_SHA" '[{"name":"design-approved"}]'
ci "$TMP/rv-changed.err" PATH="$RPATH" GH_STATE="$GHS" UI_DIFF_ROUTES="/,/pricing.html" UI_DIFF_REQUIRE_APPROVAL=true
check "visual changes → ci.sh exits 0" test $? = 0
review_status "$HEAD_SHA"
expect "$TMP/rs.json" 'd.state === "pending" && d.description === "2 pages changed — needs design review" && has(d.target_url, "#issuecomment-100")' "visual changes → pending with a count, linked to the comment"
comment_body
expect "$TMP/rc.md" "has(d, '<!-- ui-diff:review sha=$HEAD_SHA pages=2 failed=0 -->') && has(d, '- [ ] **Design approved** — tick to approve these UI changes')" "comment has an unticked box tied to the head sha"
expect "$GHS/calls.log" 'has(d, "-X DELETE repos/acme/demo/issues/8/labels/design-approved")' "drops an approval label left from an earlier commit"
N="$(posts)"

tick_event bob x; approve
check "read-only user → exits 0" test $? = 0
expect "$TMP/ap.err" 'has(d, "@bob doesn\x27t have write access")' "read-only user's tick is ignored"
check "read-only user → no status change" test "$(posts)" = "$N"
tick_event bob ' '

tick_event alice x; approve
review_status "$HEAD_SHA"
expect "$TMP/rs.json" 'd.state === "success" && d.description === "Approved by @alice" && has(d.target_url, "#issuecomment-100")' "writer ticks → success, approved by them"
comment_body
expect "$TMP/rc.md" "has(d, '- [x] **Design approved**') && has(d, '✅ Approved by @alice for \`${HEAD_SHA:0:7}\`')" "comment gets the approval line"
expect "$GHS/calls.log" 'has(d, "collaborators/alice/permission")' "looked up the editor's permission"

N="$(posts)"
node -e 'const fs=require("fs"),f=process.argv[1],e=require(f); e.changes.body.from=e.comment.body; fs.writeFileSync(f, JSON.stringify(e))' "$TMP/event.json"
approve
expect "$TMP/ap.err" 'has(d, "didn\x27t change")' "an edit that doesn't flip the box is ignored"
check "…and sets no status" test "$(posts)" = "$N"

tick_event mo ' '; approve
review_status "$HEAD_SHA"
expect "$TMP/rs.json" 'd.state === "pending" && d.description === "2 pages changed — needs design review"' "maintainer unticks → back to pending"
comment_body
expect "$TMP/rc.md" '!has(d, "Approved by") && has(d, "- [ ] **Design approved**")' "approval line removed"

# Stale: the PR moved on to a new commit while the old comment is still up.
NEW_SHA="ffffffffffffffffffffffffffffffffffffffff"
set_head "$NEW_SHA"
N="$(posts)"
tick_event alice x; approve
expect "$TMP/ap.err" 'has(d, "(stale)")' "tick on a comment for an old sha is ignored"
check "stale tick → no status on any sha" test "$(posts)" = "$N"
review_status "$NEW_SHA"
expect "$TMP/rs.json" '!d.state' "new sha not approved"
pr_event labeled "$NEW_SHA" '[{"name":"design-approved"}]' design-approved alice; approve
expect "$TMP/ap.err" 'has(d, "(stale)")' "label on a PR whose result is for an old sha is ignored"
tick_event alice ' '
set_head "$HEAD_SHA"

# Label approval.
pr_event labeled "$HEAD_SHA" '[{"name":"design-approved"}]' design-approved bob; approve
expect "$TMP/ap.err" 'has(d, "@bob doesn\x27t have write access")' "label by a read-only user is ignored"
pr_event labeled "$HEAD_SHA" '[{"name":"bug"}]' bug alice; approve
expect "$TMP/ap.err" 'has(d, "isn\x27t \x27design-approved\x27")' "other labels are ignored"
pr_event labeled "$HEAD_SHA" '[{"name":"design-approved"}]' design-approved alice; approve
review_status "$HEAD_SHA"
expect "$TMP/rs.json" 'd.state === "success" && d.description === "Approved by @alice"' "approval label → success"
comment_body
expect "$TMP/rc.md" 'has(d, "- [x] **Design approved**") && has(d, "✅ Approved by @alice")' "label approval ticks the box"

# A re-run on the same commit keeps the approval.
ci "$TMP/rv-rerun.err" PATH="$RPATH" GH_STATE="$GHS" UI_DIFF_ROUTES="/,/pricing.html" UI_DIFF_REQUIRE_APPROVAL=true
review_status "$HEAD_SHA"
expect "$TMP/rs.json" 'd.state === "success" && d.description === "Approved by @alice"' "re-run on an approved sha keeps the approval"
comment_body
expect "$TMP/rc.md" 'has(d, "- [x] **Design approved**") && has(d, "✅ Approved by @alice")' "…and renders the box ticked"

pr_event unlabeled "$HEAD_SHA" '[]' design-approved alice; approve
review_status "$HEAD_SHA"
expect "$TMP/rs.json" 'd.state === "pending"' "removing the label → back to pending"

pr_event labeled "$HEAD_SHA" '[{"name":"design-approved"}]' design-approved 'github-actions[bot]'; approve
expect "$TMP/ap.err" 'has(d, "made by github-actions[bot] itself")' "the bot's own edits never approve"
if python3 -c 'import yaml' 2>/dev/null; then
  for y in "$HERE/../action.yml" "$HERE"/../examples/workflows/*.yml; do
    check "$(basename "$y") parses" python3 -c 'import sys, yaml; yaml.safe_load(open(sys.argv[1]))' "$y"
  done
fi

# ---------------------------------------------------------------------------------
section "e2e: non-visual change → no false positives (determinism)"
cd "$REPO"
echo "# notes" > NOTES.md && git add NOTES.md && commit "docs only"
bash "$S/run.sh" --base HEAD~1 --routes "/,/pricing.html" > /dev/null 2> "$TMP/noop.err"
check "run.sh exits 0" test $? = 0
expect "$REPO/.ui-diff/report/results.json" 'd.summary.changed === 0 && d.summary.unchanged === 4' "identical UI gives identical pixels (0 changed)"

section "e2e: noise on base is re-checked and ignored (recheck)"
cp "$FIX/noise/base/"*.html . && git add -A && commit "live boxes"
cp "$FIX/noise/head/"*.html . && git add -A && commit "heading color"
bash "$S/run.sh" --base HEAD~1 --routes "/noisy.html,/quiet.html" --viewports "desktop:1000x700" > /dev/null 2> "$TMP/noise.err"
check "run.sh exits 0" test $? = 0
R="$REPO/.ui-diff/report"
expect "$TMP/noise.err" 'has(d, "re-checking 2 changed capture(s) on base")' "re-captures the two pages that differ"
expect "$R/results.json" 'item(d, "quiet-html__desktop.png").status === "unchanged" && item(d, "quiet-html__desktop.png").unstable.ignored > 0' "page whose only change is base noise → unchanged, with the noise counted"
expect "$R/results.json" '((i) => i.status === "changed" && i.unstable.ignored > 0 && i.regions.length === 1 && i.regions[0].y > 300)(item(d, "noisy-html__desktop.png"))' "real change still reported; the noisy box isn't one of its areas"
expect "$R/results.json" '((m) => m.styles.some((g) => g.prop === "color" && g.to === "#be123c") && !m.styles.some((g) => g.prop === "background-color") && !m.copy.length && m.ignored > 0)(item(d, "noisy-html__desktop.png").measured)' "measured: heading color kept, the box's random color and text left out"
expect "$R/results.json" 'd.summary.changed === 1 && d.summary.unstable === 2' "summary counts 1 changed, 2 with noise"
node "$S/comment.cjs" --report "$R" --base-url https://example.test > "$TMP/noise.md" 2>/dev/null
expect "$TMP/noise.md" 'has(d, "that also differ between two loads of base were ignored")' "comment says how much noise was ignored"
printf '{"recheck":false}' > "$TMP/norecheck.json"
bash "$S/run.sh" --base HEAD~1 --routes "/quiet.html" --viewports "desktop:1000x700" --config "$TMP/norecheck.json" > /dev/null 2> "$TMP/norecheck.err"
expect "$R/results.json" 'item(d, "quiet-html__desktop.png").status === "changed" && !d.summary.unstable' '"recheck": false → noise reported as a change'
git rm -q noisy.html quiet.html && commit "drop live boxes"

section "e2e: uncommitted changes are labelled"
echo '.card h3 { letter-spacing: 0.05em; }' >> style.css
echo '{ "animate": false }' > "$TMP/noanim.json"
bash "$S/run.sh" --base HEAD --routes "/pricing.html" --config "$TMP/noanim.json" > /dev/null 2> "$TMP/dirty.err"
check "run.sh exits 0" test $? = 0
expect "$REPO/.ui-diff/report/run.json" 'd.head.dirty === true' "run.json marks head as dirty"
expect "$REPO/.ui-diff/report/measured.md" 'has(d, "`letter-spacing`")' "uncommitted CSS change is measured"
expect "$REPO/.ui-diff/report/results.json" 'd.items.some((i) => (i.regions || []).some((r) => r.zoom)) && !JSON.stringify(d).includes("flip")' 'config "animate": false → zoom crops but no flips'
check "no flip files written" test -z "$(find "$REPO/.ui-diff/report" -name '*__flip.png')"
git checkout -q -- style.css

section "e2e: --auto-routes picks the pages from the diff (routes.cjs)"
bash "$S/run.sh" --base main --auto-routes > /dev/null 2> "$TMP/auto.err"
check "run.sh --auto-routes exits 0" test $? = 0
expect "$REPO/.ui-diff/report/run.json" 'JSON.stringify([...d.routes].sort()) === JSON.stringify(["/", "/new.html", "/pricing.html"])' "captures /, /pricing.html and the new page; not the untouched /about.html"
expect "$TMP/auto.err" 'has(d, "/pricing.html [high]") && has(d, "new page new.html") && has(d, "imports style.css")' "logs each route with its reasons"
check "routes.cjs --base in the repo (git mode) agrees" test "$(node "$S/routes.cjs" --base main --print | tr ',' '\n' | sort | tr '\n' ,)" = "/,/new.html,/pricing.html,"

section "e2e: failures are reported and cleaned up"
bash "$S/run.sh" --base HEAD~1 --dev "sh -c 'echo boom >&2; exit 3'" > /dev/null 2> "$TMP/fail.err"
check "run.sh exits non-zero" test $? != 0
expect "$TMP/fail.err" 'has(d, "server exited") && has(d, "boom")' "error names the failing server and shows its log"
check "temporary worktree removed after failure" no_extra_worktrees "$REPO"
bash "$S/run.sh" --base HEAD > /dev/null 2> "$TMP/same.err"
check "nothing to compare → exits non-zero" test $? != 0
expect "$TMP/same.err" 'has(d, "nothing to compare")' "explains there's nothing to compare"

# ---------------------------------------------------------------------------------
if [ "$FULL" = 1 ]; then
  section "e2e (full): real Vite + React app"
  cd "$TMP"
  if npm create -y vite@6.5.0 vite-app -- --template react >/dev/null 2>&1 && cd vite-app && npm install --silent --no-audit --no-fund >/dev/null 2>&1; then
    git init -q -b main && git add -A && commit base
    git checkout -q -b cta
    echo '.card button { background: #16a34a; color: white; border-radius: 999px; padding: 0.9em 1.8em; }' >> src/App.css
    git add -A && commit "green CTA"
    bash "$S/run.sh" > "$TMP/vite.out" 2> "$TMP/vite.err"
    RC=$?
    check "run.sh exits 0" test $RC = 0
    if [ $RC != 0 ]; then # show why (CI has no other way to see it)
      tail -20 "$TMP/vite.err" | sed 's/^/    | /'
      for f in .ui-diff/*.log; do [ -f "$f" ] && { echo "    | --- $f"; tail -15 "$f" | sed 's/^/    | /'; }; done
    fi
    expect "$TMP/vite.err" 'has(d, "npm run dev -- --port {port} --strictPort")' "detects the Vite dev command"
    expect "$TMP/vite.err" 'has(d, "reusing installed dependencies")' "reuses node_modules for base (same lockfile)"
    V="$TMP/vite-app/.ui-diff/report"
    expect "$V/results.json" 'd.summary.changed === 2 && d.summary.error === 0' "home page changed on desktop + mobile"
    expect "$V/results.json" 'd.items.every((i) => !i.warnings)' "no page errors or dev overlays"
    expect "$V/measured.md" 'has(d, "`background-color`: #f9f9f9 → #16a34a") && has(d, "`border-radius`: 8px → 999px")' "measures the button restyle"
    expect "$V/measured.md" 'has(d, "contrast 3.3:1")' "flags white-on-green contrast"
    check "temporary worktree removed" no_extra_worktrees "$TMP/vite-app"
  else
    echo "  ✗ couldn't scaffold the Vite app (network?)"; FAIL=$((FAIL + 1))
  fi

  section "e2e (full): Storybook mode on a real Storybook (React + Vite)"
  cd "$TMP"
  if npm create -y vite@6.5.0 sb-app -- --template react >/dev/null 2>&1 && cd sb-app &&
     npm install --silent --no-audit --no-fund >/dev/null 2>&1 &&
     npm install --silent --no-audit --no-fund -D storybook@10.6.7 @storybook/react-vite@10.6.7 >/dev/null 2>&1; then
    npm pkg set scripts.storybook="storybook dev -p 6006"
    mkdir -p .storybook
    echo "export default { stories: ['../src/**/*.stories.jsx'], framework: '@storybook/react-vite' };" > .storybook/main.js
    echo ".btn { padding: 8px 14px; border: 0; border-radius: 4px; background: #2563eb; color: white; }" > src/Button.css
    printf '%s\n' "import './Button.css';" "export const Button = ({ label }) => <button className=\"btn\">{label}</button>;" > src/Button.jsx
    printf '%s\n' "import { Button } from './Button';" "export default { title: 'Button', component: Button };" \
      "export const Primary = { args: { label: 'Save' } };" > src/Button.stories.jsx
    printf '%s\n' "export default { title: 'Note' };" "export const Plain = { render: () => <p>Unrelated</p> };" > src/Note.stories.jsx
    git init -q -b main && git add -A && commit base
    git checkout -q -b green
    echo ".btn { padding: 8px 14px; border: 0; border-radius: 999px; background: #16a34a; color: white; }" > src/Button.css
    echo "export const Long = { args: { label: 'Save and continue' } };" >> src/Button.stories.jsx
    git add -A && commit "green pill button"
    bash "$S/run.sh" --storybook > "$TMP/sb.out" 2> "$TMP/sb.err"
    check "run.sh --storybook exits 0" test $? = 0
    expect "$TMP/sb.err" 'has(d, "npm run storybook -- -p {port} --ci")' "detects the Storybook command"
    B="$TMP/sb-app/.ui-diff/report"
    expect "$B/results.json" 'item(d, "button--primary__desktop.png").status === "changed" && item(d, "button--primary__mobile.png").status === "changed"' "changed component's story is changed"
    expect "$B/results.json" 'item(d, "button--long__desktop.png").status === "added"' "story only on head is new"
    expect "$B/results.json" '!d.items.some((i) => i.name === "note--plain") && d.summary.error === 0 && d.items.every((i) => !i.warnings)' "unrelated story not captured; no errors"
    expect "$B/measured.md" 'has(d, "`background-color`: #2563eb → #16a34a") && has(d, "`border-radius`: 4px → 999px")' "measures the restyle"
    expect "$B/run.json" 'd.storybook === true && d.routes.includes("button--primary")' "run.json lists stories"
    for p in $(node -e 'const r=require(process.argv[1]);console.log(r.ports.base, r.ports.head)' "$B/run.json"); do check "Storybook on :$p was stopped" port_closed "$p"; done
    check "temporary worktree removed" no_extra_worktrees "$TMP/sb-app"
  else
    echo "  ✗ couldn't set up the Storybook app (network?)"; FAIL=$((FAIL + 1))
  fi
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
