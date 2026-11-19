---
name: ui-diff
description: Show the visual / UI / UX impact of a pull request. Renders the affected pages of a web app at the base and head commits, pixel-diffs the screenshots, measures exact style changes (colors, spacing, type, contrast), writes a plain-language summary for designers and reviewers, and posts before/after images to the PR as a comment or in the description. Use this whenever someone wants reviewers to *see* a frontend change — "add screenshots to my PR", "what does this PR look like", "visual diff", "before/after", "design review", "did my CSS change break anything", "show the UI changes", "visual regression check" — even if they don't say "UI diff" or "design diff". Works with any web app that runs on a local dev server (React, Next.js, Vue, Nuxt, Svelte, Angular, Astro, plain HTML).
license: MIT (see LICENSE.txt)
compatibility: Needs bash, git and Node.js 18+; the GitHub CLI (gh, logged in) to post to PRs; python3 for plain-HTML sites. The first run downloads Playwright + Chromium (~150 MB) into ~/.cache/ui-diff. macOS or Linux.
metadata:
  author: davidamunga
  version: "0.3.0"
---

# UI diff

Reviewers can read a CSS diff, but they can't see it. This skill renders the app at the
PR's base and head, compares them, and puts before/after images on the PR. Alongside them
goes a short summary of what changed for users, backed by measured values.

The mechanical work is a single script. Your job is the parts that need judgment:
**which pages to check**, **what the changes mean**, and **where to post**.

`$SKILL` below means the directory that contains this `SKILL.md`. Set it once, e.g.
`SKILL=/path/to/skills/ui-diff`. Everything is written to `.ui-diff/` at the repo root,
which the script git-ignores locally, so nothing tracked changes.

## 1. Context

```bash
gh pr view --json number,url,baseRefName,headRefOid,body 2>/dev/null; git status --short
```

Read `.ui-diff.json` at the repo root if it exists. It may hold routes, the dev command,
masks and auth (see `references/config.md`).

**Which head to render** depends on what the user is doing:
- **Posting to a PR:** render exactly what's pushed by passing `--head <headRefOid>`.
  Otherwise uncommitted local edits end up in a report that claims to show the PR. If the
  working tree is dirty or has unpushed commits, mention that those changes won't appear.
- **Checking their work in progress** ("does this look right?"): use the working tree (the
  default, no `--head`). The report labels it "+ uncommitted changes".

## 2. Choose the pages

```bash
node $SKILL/scripts/routes.cjs --base <base> --log   # add --head <sha> if you'll pass it to run.sh
```

It maps the changed files to routes: page files, routes under a changed layout, pages that
import a changed component (following aliases and workspace packages), and home plus a few
well-linked pages for app-wide styles. It prints JSON with each route's reasons and
confidence, `needsExample` (dynamic routes it can't fill in), and `unmatched` (UI files it
couldn't place). Treat it as a starting list and apply judgement using
`references/route-mapping.md`: drop low-confidence picks the diff doesn't support, find ids
for `needsExample`, and place `unmatched` files yourself. If nothing UI-related changed (all
files `ignored`), say so and stop. Don't produce an empty report.

**Storybook projects** (a `.storybook/` folder or a `storybook` script): when the change is
mostly to components, diff their stories instead of pages with `run.sh --storybook`; it
picks the stories from the changed files itself. Stay with pages for routes, layouts and
app-level styles. See the Storybook section of `references/route-mapping.md`.

Tell the user in a line or two which routes you'll capture and why, then continue. Only ask
when you can't find any route, or when a dynamic route needs an id you can't find. Keep
track of routes that are **affected but not captured** (too many to check, needs a login,
a modal state). They go in the summary so "no visual change" isn't read as an all-clear.

## 3. Run it

```bash
bash $SKILL/scripts/run.sh --routes "/,/pricing" [--head <sha>] [--base <ref>] \
  [--viewports "desktop:1440x900,mobile:iPhone 13"] [--schemes light,dark] [--dev "<cmd with {port}>"]
```

(`--auto-routes` adds the routes `routes.cjs` picks, logged with reasons; use it when you
have no corrections to make.)

In one go, it:
- installs the tools on first use (Playwright + Chromium in `~/.cache/ui-diff`, about a minute; the project's dependencies are untouched);
- checks out base, and head if `--head` is given, in git worktrees, and copies untracked `.env*` files into them;
- reuses installed dependencies when the lockfile matches, with per-checkout build caches, and installs otherwise;
- starts both dev servers on free ports in their own process groups. Only those are stopped
  afterwards, so the user's other servers are never touched;
- captures every route × viewport. Mobile uses real device emulation (touch, mobile UA).
  Animations are frozen, framework dev overlays are hidden, both sides' page clocks start at
  the same instant and `Math.random` is seeded;
- pixel-diffs the screenshots (`results.json`, full-page and zoomed images) and runs a computed-style diff (`measured.md`);
- loads each changed page on base a second time. Whatever differs between those two loads
  (carousels, live data, ads) is noise: it's left out of the counts, the zoomed areas and
  `measured.md`, and painted blue in the diff image. `item.unstable` says how much was ignored.

**Storybook mode** (`--storybook`, or `--stories "button--primary,card--*"` to choose them
yourself) starts Storybook instead of the dev server, logs which stories it picked and why,
and names results by story id. If no story matches, it exits and suggests ids.

It prints counts like `{"changed":2,"added":1,"unchanged":3,...}`. Defaults: base = the PR's
base branch (else the default branch), viewports = desktop 1440×900 + iPhone 13, light mode.
Add `--schemes light,dark` when the change touches theme, colors or tokens.

**If it fails**, the error says which step failed and where its log is (`.ui-diff/server-*.log`,
`install-*.log`, `capture-*.log`). The usual causes are a missing env var, the wrong dev
command (pass `--dev`), or dependencies not installed in the working tree. Fix the cause and
rerun. Don't skip one side.

## 4. Read the results and write the summary

Read `.ui-diff/report/measured.md` first. If it opens with **Possible problems**, check those
first: clipped text, sideways scroll, overlap, off-screen controls, small mobile tap targets
and axe-core accessibility violations that are new on head. They're heuristics, so open each
zoom image (`report/issues/`) and judge it. Lead "worth a look" with the real ones, and drop or
soften any that look intentional. The rest of `measured.md` holds **measured** facts: computed-style
changes grouped across elements, resized elements, layout shifts, copy changes, and
**new** WCAG contrast failures. Then open the zoom images (`report/zoom/*__after.png` and `__before.png`)
and diff overlays with whatever file or image viewing tool you have to see how those facts
look in context. If you can't view images, write the summary from `measured.md` alone and
say the screenshots weren't reviewed. Check
`results.json` for `warnings` too: HTTP errors, framework error overlays, uncaught exceptions.

**Figma link given** (or a route in `.ui-diff.json` has `figma`)? Also compare head with the
design frame. Follow `references/figma.md`.

Write `.ui-diff/report/summary.md` for a designer or PM who won't read the code:

```markdown
**What changed**
- **Pricing cards** — CTA buttons are now pills (radius 4 → 999px) with more padding (8×14 → 12×20px); the Pro card is highlighted (2px `#2563EB` border, `#EFF6FF` fill) with a "Most popular" label.
- **Header (all pages)** — nav links went from blue `#2563EB` to gray `#9CA3AF`.

**Worth a look**
- ⚠️ Nav links are now 2.5:1 contrast on white (was 5.2:1); body text needs 4.5:1.
- ⚠️ `/settings` changed but none of its files did — it picks up the new `Button` padding, and "Save"/"Cancel" now wrap on mobile.

**Not checked:** `/admin/*` (needs login), the delete-account modal.
```

Guidelines:
- **Use measured values** from `measured.md` for colors, sizes and spacing. Don't estimate
  them from pixels. If something is visible in the images but not in `measured.md`
  (images, canvas, SVG content), describe it as seen.
- A large pixel-change percentage with "shifted … layout shift" lines usually means content
  was pushed down, not that everything changed. Explain it that way.
- Lead "worth a look" with **likely unintended** changes: pages that changed without their
  files changing, breakage at one viewport only, overflow, vanished elements, page errors.
  Then contrast failures and small touch targets (under about 44px on mobile).
- Say "changed", not "intentionally changed". You can see what changed, not why.
- Keep it proportional. A one-color tweak gets one bullet.

**Flow or visual.** Each changed area's animation carries a tag, **Flow change** or **Visual
only**, and a one-line note. `run.sh` already filled them in automatically (`🔀 flow:` lines in
`measured.md` are the flow changes it found: controls added or removed, links pointing
somewhere new, fields that became required, reordered actions, new or removed pages). Replace
the automatic notes with your own words where they'd help a reviewer, the same voice as the
summary. Get the area ids with `node $SKILL/scripts/annotate.cjs --report .ui-diff/report --list`,
write `.ui-diff/report/notes.json`, and rerun `annotate.cjs` (it redraws the animations):

```json
{
  "settings__desktop__light__r3": { "kind": "flow", "note": "Asks for a phone number before SMS alerts can be turned on" },
  "/settings": "Cards are rounder (12 → 20px corners)",
  "/pricing": { "kind": "visual", "note": "Headline rewritten" }
}
```

- Keys are an area id, a route, or `"*"`; the most specific wins. A bare string for a route
  or `"*"` only reaches its visual areas, so a page-wide note never hides a flow change.
- Call it a flow change when what users can do, or the order or place they do it, changed
  (a new step, field, button or destination), even when it looks small. Set `"kind"` to
  correct the automatic tag when it's wrong, e.g. a link that only gained a query parameter.
- Keep notes under about 90 characters; the bar shows two lines.

Then run `node $SKILL/scripts/viewer.cjs --report .ui-diff/report` to refresh the local review page (`report/index.html`: slider, side by side, diff overlay, summary on top) and offer to open it for the user (`open` on macOS, `xdg-open` on Linux).

## 5. Publish

Posting writes to a shared PR and pushes a branch. **Show the user the summary and confirm
first**, unless their request already said to post. Then:

```bash
PREFIX=$(bash $SKILL/scripts/publish.sh .ui-diff/report <pr> <head-short-sha>)
node $SKILL/scripts/comment.cjs --report .ui-diff/report --base-url "$PREFIX" \
  --summary .ui-diff/report/summary.md --out .ui-diff/comment.md
node $SKILL/scripts/post.cjs --pr <pr> --body .ui-diff/comment.md --mode comment   # or --mode description
```

- `publish.sh` pushes the images to a `ui-diff-assets` branch (one commit, replaced on
  each publish) from a throwaway clone. Images then render inline on GitHub, including in
  private repos for anyone with read access.
  - **Exit 3** means no push access (typically a PR from a fork). Switch to manual mode.
  - If it notes the repo is **public**, tell the user the screenshots will be public. That
    matters most when `storageState` logged in as a real account. Get a yes before posting.
- `post.cjs` replaces the previous ui-diff comment or description section instead of
  stacking new ones. Everything else in the description is left as it was.
- Add `--approval` to `comment.cjs` only if `.ui-diff.json` has `"requireApproval": true`
  (the repo runs the design-review workflow): it adds a "Design approved" box.
- **Manual mode** (no assets branch, or no push access): run `comment.cjs` without
  `--base-url`, then `open .ui-diff/report`. The user drags the images into the PR
  comment box (GitHub has no API for that upload). Tell them which image goes where.
- **No PR yet:** keep `.ui-diff/comment.md` and offer to put it in the description when
  the PR is opened.

## 6. Wrap up

Report back with the link, the counts, and the "worth a look" items. If you worked out the
dev command, routes, masks or dynamic ids yourself, offer to save them to `.ui-diff.json`
so the next run is a single step. Once a PR is merged or closed, `bash $SKILL/scripts/prune.sh <pr>`
removes its images from the assets branch (ask first if anyone might still need its comment).
