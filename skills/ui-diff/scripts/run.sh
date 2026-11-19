#!/usr/bin/env bash
# Whole pipeline in one command: check out base (and optionally head) in worktrees, start
# both dev servers on free ports, capture screenshots, pixel-diff and style-diff them.
# Run from anywhere inside the repo.
#
# Usage: run.sh [--base <ref>] [--head <ref>] [--routes "/,/pricing"] [--viewports "desktop:1440x900,mobile:iPhone 13"]
#               [--schemes light,dark] [--dev "<command with {port}>"] [--config <file>] [--keep]
#               [--storybook [--stories "id1,id2"]] [--auto-routes]
#
#   --base   default: the open PR's base branch, else origin's default branch, else main/master
#   --head   a commit/ref to render instead of the working tree (use the PR's head SHA when
#            posting to a PR, so the report shows exactly what's pushed)
#   --keep   leave servers' worktrees in place afterwards (for debugging)
#   --storybook  diff Storybook stories instead of pages (also config "storybook": true); the
#            stories are picked from the changed files (stories.cjs), or given with --stories
#   --auto-routes  add the routes routes.cjs picks from the changed files (logged with reasons)
#
# Output: .ui-diff/report/ — results.json, run.json, measured.md, index.html (review page) and the images.
# Servers are started in their own process groups and only those groups are stopped;
# nothing else running on the machine is touched.
set -euo pipefail

S="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
WORK="$ROOT/.ui-diff"
BASE_ARG="" HEAD_ARG="" ROUTES="" VIEWPORTS="" SCHEMES="" DEV="" KEEP=0 SB=0 STORIES="" AUTO=0
CONFIG=""; [ -f "$ROOT/.ui-diff.json" ] && CONFIG="$ROOT/.ui-diff.json"

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE_ARG="$2"; shift 2 ;;
    --head) HEAD_ARG="$2"; shift 2 ;;
    --routes) ROUTES="$2"; shift 2 ;;
    --viewports) VIEWPORTS="$2"; shift 2 ;;
    --schemes) SCHEMES="$2"; shift 2 ;;
    --dev) DEV="$2"; shift 2 ;;
    --config) CONFIG="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --storybook) SB=1; shift ;;
    --stories) STORIES="$2"; SB=1; shift 2 ;;
    --auto-routes) AUTO=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

log() { echo "› $*" >&2; }
die() { echo "✗ $*" >&2; exit 1; }
# Read a config key; arrays come back one item per line.
cfg() {
  [ -n "$CONFIG" ] || return 0
  node -e 'const v=require(process.argv[1])[process.argv[2]];if(v!==undefined)console.log(Array.isArray(v)?v.join("\n"):v)' "$CONFIG" "$1"
}
# Storybook config: "storybook": true or { "dir": "packages/ui", "command": "...", ... }.
sbcfg() {
  [ -n "$CONFIG" ] || return 0
  node -e 'const s=require(process.argv[1]).storybook;if(!s)process.exit();const v=process.argv[2]==="on"?1:(s===true?{}:s)[process.argv[2]];if(v!==undefined)console.log(v)' "$CONFIG" "$1"
}
[ -n "$(sbcfg on)" ] && SB=1
SB_DIR="$(sbcfg dir)"; SB_DIR="${SB_DIR%/}"
APP="${SB_DIR:+/$SB_DIR}" # the app's dir inside each checkout (Storybook may live in a sub-package)

# --- tools & local ignore ---------------------------------------------------------
bash "$S/setup.sh" >/dev/null
EXCLUDE="$(git rev-parse --git-common-dir)/info/exclude"
mkdir -p "$(dirname "$EXCLUDE")" "$WORK"
grep -qxF '.ui-diff/' "$EXCLUDE" 2>/dev/null || echo '.ui-diff/' >> "$EXCLUDE"

# --- resolve base & head ----------------------------------------------------------
if [ -n "$HEAD_ARG" ]; then
  git rev-parse -q --verify "$HEAD_ARG^{commit}" >/dev/null || git fetch -q origin "$HEAD_ARG" || die "can't find head $HEAD_ARG"
  HEAD_SHA="$(git rev-parse "$HEAD_ARG^{commit}" 2>/dev/null || git rev-parse FETCH_HEAD)"
  HEAD_DIRTY=false
else
  HEAD_SHA="$(git rev-parse HEAD)"
  HEAD_DIRTY=false; [ -n "$(git status --porcelain)" ] && HEAD_DIRTY=true
fi

if [ -n "$BASE_ARG" ]; then
  BASE_REF="$BASE_ARG"
else
  BR="$(gh pr view --json baseRefName -q .baseRefName 2>/dev/null || true)"
  [ -n "$BR" ] || BR="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"
  if [ -z "$BR" ]; then for b in main master; do git rev-parse -q --verify "$b" >/dev/null && BR="$b" && break; done; fi
  [ -n "$BR" ] || die "can't work out the base branch; pass --base"
  if git fetch -q origin "$BR" 2>/dev/null; then BASE_REF="origin/$BR"; else BASE_REF="$BR"; fi
fi
BASE_SHA="$(git merge-base "$BASE_REF" "$HEAD_SHA")" || die "no merge-base between $BASE_REF and head"
[ "$BASE_SHA" != "$HEAD_SHA" ] || [ "$HEAD_DIRTY" = true ] || die "head is the same commit as base ($BASE_REF) and has no local changes; nothing to compare"
log "base $BASE_REF @ ${BASE_SHA:0:7}  →  head ${HEAD_ARG:-working tree} @ ${HEAD_SHA:0:7}$([ "$HEAD_DIRTY" = true ] && echo ' + uncommitted changes')"

# --- worktrees --------------------------------------------------------------------
add_worktree() {
  git worktree remove --force "$1" 2>/dev/null || rm -rf "$1"
  git worktree prune
  git worktree add -q --detach "$1" "$2"
}

# Untracked files the app needs (env files, config.copyFiles) aren't part of a worktree.
copy_untracked() {
  local dst="$1" f
  # copyFiles entries may be files or directories (a directory is copied recursively, skipping
  # node_modules, .git and .ui-diff), e.g. a gitignored generated API client.
  { find . -maxdepth 4 \( -name node_modules -o -name .git -o -name .ui-diff \) -prune -o -name '.env*' -type f -print
    cfg copyFiles | while read -r f; do
      f="${f#./}"; f="${f%/}"
      if [ -d "$f" ]; then
        find "$f" \( -name node_modules -o -name .git -o -name .ui-diff \) -prune -o -type f -print
      else
        echo "$f"
      fi
    done; } |
    sed 's#^\./##' | sort -u | while read -r f; do
      [ -n "$f" ] && [ -f "$f" ] || continue
      git ls-files --error-unmatch "$f" >/dev/null 2>&1 && continue
      mkdir -p "$dst/$(dirname "$f")" && cp "$f" "$dst/$f"
    done
}

lockfile() { for l in pnpm-lock.yaml yarn.lock package-lock.json bun.lock bun.lockb; do [ -f "$1/$l" ] && { echo "$l"; return; }; done; return 0; } # none: empty, not a failure

# prepare_deps <checkout> [/sub/dir]: install or link deps in the checkout (or a package inside it).
prepare_deps() {
  local dst="$1${2:-}" src="$ROOT${2:-}" name; name="$(basename "$1")"
  local lock install
  [ -f "$dst/package.json" ] || return 0
  lock="$(lockfile "$dst")"
  if [ -d "$src/node_modules" ] && [ -n "$lock" ] && cmp -s "$src/$lock" "$dst/$lock"; then
    log "same $lock as working tree — reusing installed dependencies"
    node "$S/linkdeps.cjs" "$src" "$dst" >&2
    return
  fi
  install="$(cfg install)"
  if [ -z "$install" ]; then
    case "$lock" in
      pnpm-lock.yaml) install="pnpm install --frozen-lockfile" ;;
      yarn.lock) install="yarn install" ;;
      bun.lock|bun.lockb) install="bun install" ;;
      package-lock.json) install="npm ci" ;;
      *) install="npm install" ;;
    esac
  fi
  log "lockfile differs — running '$install' in $name${2:-} (log: $WORK/install-$name.log)"
  (cd "$dst" && eval "$install") > "$WORK/install-$name.log" 2>&1 ||
    { tail -n 30 "$WORK/install-$name.log" >&2; die "dependency install failed in $dst"; }
}

if [ -z "$HEAD_ARG" ] && [ -f package.json ] && [ ! -d node_modules ]; then
  die "dependencies aren't installed in the working tree; install them first (e.g. npm install)"
fi

BASE_DIR="$WORK/base"
add_worktree "$BASE_DIR" "$BASE_SHA"
copy_untracked "$BASE_DIR"
prepare_deps "$BASE_DIR"
# A Storybook in a sub-package with its own deps (not a workspace of the root).
[ -n "$APP" ] && [ ! -e "$BASE_DIR$APP/node_modules" ] && prepare_deps "$BASE_DIR" "$APP"
if [ -n "$HEAD_ARG" ]; then
  HEAD_DIR="$WORK/head"
  add_worktree "$HEAD_DIR" "$HEAD_SHA"
  copy_untracked "$HEAD_DIR"
  prepare_deps "$HEAD_DIR"
  [ -n "$APP" ] && [ ! -e "$HEAD_DIR$APP/node_modules" ] && prepare_deps "$HEAD_DIR" "$APP"
else
  HEAD_DIR="$ROOT"
fi

# --- routes from the diff (--auto-routes) ------------------------------------------
if [ "$AUTO" = 1 ] && [ "$SB" = 0 ]; then
  RA=(--root "$HEAD_DIR" --base "$BASE_SHA" --routes "$ROUTES" --log --print)
  [ -n "$HEAD_ARG" ] && RA+=(--head "$HEAD_SHA")
  [ -n "$CONFIG" ] && RA+=(--config "$CONFIG")
  AUTO_ROUTES="$(node "$S/routes.cjs" "${RA[@]}")" || die "couldn't work out routes from the diff; pass --routes"
  [ -n "$AUTO_ROUTES" ] || [ -n "$ROUTES" ] || [ -n "$(cfg routes)" ] || die "no routes found for the changed files; pass --routes \"/,/page\""
  ROUTES="${ROUTES:+$ROUTES,}$AUTO_ROUTES"; ROUTES="${ROUTES%,}"
fi

# --- servers ----------------------------------------------------------------------
if [ "$SB" = 1 ]; then
  [ -n "$DEV" ] || DEV="$(sbcfg command)"
  [ -n "$DEV" ] || DEV="$(node "$S/devcmd.cjs" "$HEAD_DIR$APP" --storybook)" || die "couldn't find Storybook in ${SB_DIR:-the repo root}; pass --dev \"<command with {port}>\" or set storybook.dir"
  READY=/index.json
  export STORYBOOK_DISABLE_TELEMETRY=1
else
  [ -n "$DEV" ] || DEV="$(cfg devCommand)"
  [ -n "$DEV" ] || DEV="$(node "$S/devcmd.cjs" "$HEAD_DIR")" || die "couldn't detect the dev command; pass --dev \"<command with {port}>\""
  READY="$(cfg readyPath)"; READY="${READY:-/}"
fi
TIMEOUT="${UI_DIFF_SERVER_TIMEOUT:-180}"
log "dev command: $DEV"

free_port() { node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})'; }

PGIDS=()
cleanup() {
  local p
  for p in "${PGIDS[@]:-}"; do [ -n "$p" ] && kill -TERM -- "-$p" 2>/dev/null || true; done
  sleep 1
  for p in "${PGIDS[@]:-}"; do [ -n "$p" ] && kill -KILL -- "-$p" 2>/dev/null || true; done
  if [ "$KEEP" = 0 ]; then
    git worktree remove --force "$BASE_DIR" 2>/dev/null || true
    [ "$HEAD_DIR" != "$ROOT" ] && git worktree remove --force "$HEAD_DIR" 2>/dev/null || true
    git worktree prune
  fi
}
trap cleanup EXIT

# Starts "$DEV" in its own process group, so cleanup can stop it and all its children
# (and only those). Must run in this shell, not a subshell, so PGIDS is recorded.
start_server() {
  local dir="$1" port="$2" name="$3" cmd="${DEV//\{port\}/$2}"
  set -m
  (cd "$dir" && PORT="$port" BROWSER=none exec bash -c "$cmd") > "$WORK/server-$name.log" 2>&1 &
  PGIDS+=("$!")
  set +m
}

wait_ready() {
  local pid="$1" port="$2" name="$3" i
  for ((i = 0; i < TIMEOUT; i++)); do
    if curl -s -o /dev/null --max-time 2 "http://localhost:$port$READY"; then return 0; fi
    kill -0 "$pid" 2>/dev/null || { tail -n 30 "$WORK/server-$name.log" >&2; die "$name server exited (log: $WORK/server-$name.log)"; }
    sleep 1
  done
  tail -n 30 "$WORK/server-$name.log" >&2
  die "$name server didn't answer on :$port within ${TIMEOUT}s"
}

BASE_PORT="$(free_port)"
HEAD_PORT="$(free_port)"
while [ "$HEAD_PORT" = "$BASE_PORT" ]; do HEAD_PORT="$(free_port)"; done
log "starting base on :$BASE_PORT and head on :$HEAD_PORT"
start_server "$BASE_DIR$APP" "$BASE_PORT" base
start_server "$HEAD_DIR$APP" "$HEAD_PORT" head
wait_ready "${PGIDS[0]}" "$BASE_PORT" base &
W1=$!
wait_ready "${PGIDS[1]}" "$HEAD_PORT" head &
W2=$!
wait "$W1" || exit 1
wait "$W2" || exit 1

CAP_BASE=() CAP_HEAD=()
if [ "$SB" = 1 ]; then
  # Changed files (committed, plus uncommitted when head is the working tree), relative to the Storybook dir.
  if [ -n "$HEAD_ARG" ]; then git diff --name-only "$BASE_SHA" "$HEAD_SHA"; else git diff --name-only "$BASE_SHA"; git ls-files --others --exclude-standard; fi |
    node -e 'const p=require("path").posix,d=process.argv[1];for(const f of require("fs").readFileSync(0,"utf8").split("\n"))if(f)console.log(p.relative(d||".",f))' "$SB_DIR" > "$WORK/changed.txt"
  SBA=(--base "http://localhost:$BASE_PORT" --head "http://localhost:$HEAD_PORT" --changed "$WORK/changed.txt"
    --root-head "$HEAD_DIR$APP" --root-base "$BASE_DIR$APP" --out "$WORK")
  [ -n "$STORIES" ] && SBA+=(--stories "$STORIES")
  [ -n "$CONFIG" ] && SBA+=(--config "$CONFIG")
  node "$S/stories.cjs" "${SBA[@]}" > "$WORK/stories.json" || die "couldn't read the stories index (log: $WORK/server-head.log)"
  node -e 'const r=require(process.argv[1]);for(const s of r.stories)console.error(`› story ${s.id}: ${s.reason}${s.only?` (${s.only} only)`:""}`);if(r.omitted)console.error(`› ${r.omitted} more stories matched; capped (pass --stories to choose)`);if(r.unmatched.length)console.error(`› no story found for: ${r.unmatched.join(", ")}`)' "$WORK/stories.json"
  [ "$(node -e 'console.log(require(process.argv[1]).stories.length)' "$WORK/stories.json")" != 0 ] ||
    die "no stories match the changed files; pass --stories \"<id>,<id>\" (ids look like: $(node -e 'console.log(require(process.argv[1]).sample.join(", "))' "$WORK/stories.json"))"
  CAP_BASE=(--config "$WORK/capture-base.json") CAP_HEAD=(--config "$WORK/capture-head.json")
  # Builders compile the preview on first load; warm it once per side.
  curl -s -o /dev/null --max-time 120 "http://localhost:$BASE_PORT/iframe.html" & W1=$!
  curl -s -o /dev/null --max-time 120 "http://localhost:$HEAD_PORT/iframe.html" & W2=$!
  wait "$W1" "$W2" || true
else
# Dev servers often compile a route on first request; warm every route so captures don't time out.
CFG_ROUTES=""
[ -n "$CONFIG" ] && CFG_ROUTES="$(node -e 'for (const r of require(process.argv[1]).routes || []) console.log(typeof r === "string" ? r : r.path)' "$CONFIG")"
ROUTE_LIST="$( { echo "$CFG_ROUTES"; echo "$ROUTES" | tr ',' '\n'; } | { grep -v '^$' || true; } | sort -u)"
[ -n "$ROUTE_LIST" ] || ROUTE_LIST="/"
# (Wait on these pids only: a bare `wait` would also wait for the servers, i.e. forever.)
WARM=()
for r in $ROUTE_LIST; do
  curl -s -o /dev/null --max-time 120 "http://localhost:$BASE_PORT$r" & WARM+=("$!")
  curl -s -o /dev/null --max-time 120 "http://localhost:$HEAD_PORT$r" & WARM+=("$!")
done
wait "${WARM[@]}" || true
fi

# --- capture & diff ---------------------------------------------------------------
rm -rf "$WORK/shots" "$WORK/report"
CAP=()
if [ "$SB" = 0 ]; then
  [ -n "$ROUTES" ] && CAP+=(--routes "$ROUTES")
  [ -n "$CONFIG" ] && CAP_BASE=(--config "$CONFIG") CAP_HEAD=(--config "$CONFIG")
fi
[ -n "$VIEWPORTS" ] && CAP+=(--viewports "$VIEWPORTS")
[ -n "$SCHEMES" ] && CAP+=(--schemes "$SCHEMES")
# One start time for every page clock, so dates and "5 minutes ago" match on base and head.
CAP+=(--time "$(node -e 'console.log(Date.now())')")
log "capturing…"
node "$S/capture.cjs" --url "http://localhost:$BASE_PORT" --out "$WORK/shots/before" ${CAP_BASE[@]+"${CAP_BASE[@]}"} ${CAP[@]+"${CAP[@]}"} 2> "$WORK/capture-base.log" > /dev/null &
C1=$!
node "$S/capture.cjs" --url "http://localhost:$HEAD_PORT" --out "$WORK/shots/after" ${CAP_HEAD[@]+"${CAP_HEAD[@]}"} ${CAP[@]+"${CAP[@]}"} 2> "$WORK/capture-head.log" > /dev/null &
C2=$!
wait "$C1" || { cat "$WORK/capture-base.log" >&2; die "base capture failed"; }
wait "$C2" || { cat "$WORK/capture-head.log" >&2; die "head capture failed"; }

DIFF=() SDIFF=()
[ "$(cfg animate)" = false ] && DIFF+=(--no-animate)
# Load the changed captures on base a second time: whatever differs between two loads of the
# same code (carousels, live data, lazy images) is noise, not this PR.
if [ "$(cfg recheck)" != false ]; then
  CHANGED="$(node "$S/diff.cjs" --before "$WORK/shots/before" --after "$WORK/shots/after" --out "$WORK/report" --dry |
    node -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8")).join(","))')"
  if [ -n "$CHANGED" ]; then
    log "re-checking $(echo "$CHANGED" | tr ',' '\n' | wc -l | tr -d ' ') changed capture(s) on base for noise…"
    if node "$S/capture.cjs" --url "http://localhost:$BASE_PORT" --out "$WORK/shots/before-recheck" --only "$CHANGED" --no-checks \
        ${CAP_BASE[@]+"${CAP_BASE[@]}"} ${CAP[@]+"${CAP[@]}"} 2> "$WORK/capture-recheck.log" > /dev/null; then
      DIFF+=(--recheck "$WORK/shots/before-recheck") SDIFF+=(--recheck "$WORK/shots/before-recheck")
    else
      log "re-check capture failed; reporting without it (log: $WORK/capture-recheck.log)"
    fi
  fi
fi
SUMMARY="$(node "$S/diff.cjs" --before "$WORK/shots/before" --after "$WORK/shots/after" --out "$WORK/report" ${DIFF[@]+"${DIFF[@]}"})"
node "$S/stylediff.cjs" --before "$WORK/shots/before" --after "$WORK/shots/after" --report "$WORK/report" ${SDIFF[@]+"${SDIFF[@]}"} > /dev/null
# Tag each changed area "Flow change" / "Visual only" with a one-line note, on the animation too.
ANN=(); [ "$(cfg animate)" = false ] && ANN+=(--no-animate)
node "$S/annotate.cjs" --report "$WORK/report" ${ANN[@]+"${ANN[@]}"} > /dev/null 2> "$WORK/annotate.log" ||
  log "couldn't annotate the animations; they keep plain BEFORE/AFTER labels (log: $WORK/annotate.log)"

node -e '
const [out, baseRef, baseSha, headRef, headSha, dirty, basePort, headPort, sb] = process.argv.slice(1);
const m = [...require(out + "/../shots/after/manifest.json"), ...require(out + "/../shots/before/manifest.json")];
require("fs").writeFileSync(out + "/run.json", JSON.stringify({
  base: { ref: baseRef, sha: baseSha }, head: { ref: headRef || "working tree", sha: headSha, dirty: dirty === "true" },
  routes: [...new Set(m.map((e) => e.route))], viewports: [...new Set(m.map((e) => e.viewport))], schemes: [...new Set(m.map((e) => e.scheme))],
  ports: { base: Number(basePort), head: Number(headPort) }, ...(sb === "1" ? { storybook: true } : {}),
}, null, 2));
' "$WORK/report" "$BASE_REF" "$BASE_SHA" "$HEAD_ARG" "$HEAD_SHA" "$HEAD_DIRTY" "$BASE_PORT" "$HEAD_PORT" "$SB"

node "$S/viewer.cjs" --report "$WORK/report" > /dev/null
log "done — $WORK/report"
log "review page: $WORK/report/index.html"
echo "$SUMMARY"
