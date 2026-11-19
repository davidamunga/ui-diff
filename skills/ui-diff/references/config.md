# `.ui-diff.json` (optional, repo root)

Saves what you'd otherwise rediscover every run. Everything is optional.

```json
{
  "devCommand": "pnpm dev --port {port}",
  "install": "pnpm install --frozen-lockfile",
  "readyPath": "/",
  "copyFiles": [".env.local"],
  "routes": [
    "/",
    "/pricing",
    { "path": "/users/42", "name": "user-profile", "waitFor": "[data-testid=profile]" },
    { "path": "/pricing", "figma": "https://www.figma.com/design/AbC123/App?node-id=12-34" },
    { "path": "/settings", "name": "settings-delete-modal",
      "actions": [{ "click": "text=Delete account" }, { "wait": "[role=dialog]" }] }
  ],
  "viewports": { "desktop": { "width": 1440, "height": 900 }, "mobile": { "device": "iPhone 13" } },
  "colorSchemes": ["light", "dark"],
  "mask": ["[data-testid=timestamp]", ".avatar"],
  "hide": ["#intercom-container", ".cookie-banner"],
  "css": "",
  "fullPage": true,
  "settleMs": 300,
  "storageState": ".ui-diff/auth.json",
  "checks": { "tapTargets": false, "ignore": [".carousel", "#chat-widget"], "ignoreRules": ["link-name"] },
  "post": "comment",
  "requireApproval": false,
  "clock": "2025-06-01T12:00:00Z",
  "seedRandom": true,
  "recheck": true
}
```

| Key | Meaning |
|---|---|
| `devCommand` | Starts the app. `{port}` is replaced with a free port; `PORT` is also set in the env. Auto-detected from `package.json` when absent. |
| `install` | Install command for the base worktree when its lockfile differs from head's. |
| `readyPath` | Polled until it answers before capturing. |
| `copyFiles` | Extra untracked files or directories to copy into the worktrees, relative to the repo root (untracked `.env*` files are copied automatically). A directory is copied recursively, skipping `node_modules`, `.git` and `.ui-diff`; use it for gitignored generated code the dev server needs, such as an API client. |
| `routes` | Always-captured routes, on top of the ones inferred from the diff. Give a unique `name` when the same path appears twice (e.g. with different `actions`). |
| `routeParams` | Example values for dynamic routes, so `routes.cjs` (and the Action) can include them: by param name `{ "id": "42", "slug": "hello-world" }`, or by route `{ "/blog/[slug]": "/blog/hello-world" }`. |
| `appDir` | In a monorepo, the package whose routes to map changed files to (e.g. `"apps/web"`); detected when absent. |
| `maxRoutes` | Cap on routes picked from the diff (default 8). |
| `figma` | Figma frame link to compare the head screenshot with: a string (first viewport) or `{ "<viewport>": "<url>" }`. See `figma.md`. |
| `actions` | Steps before the screenshot: `{click}`, `{hover}`, `{fill: [sel, value]}`, `{press: key}`, `{wait: ms or selector}`. |
| `viewports` | Name → `{width, height}` for a desktop window, or `{device: "<Playwright device>"}` (e.g. `"iPhone 13"`, `"Pixel 7"`, `"iPad Mini"`) for real mobile emulation: touch, mobile UA, `isMobile`. |
| `deviceScaleFactor` | Pixel density for all viewports (default 1 for desktop, the device's value capped at 2 for devices). |
| `mask` | Selectors painted over with a solid box on both sides (dynamic content: dates, avatars, random data). |
| `hide` | Selectors removed from screenshots (chat widgets, cookie banners). Framework dev overlays (Next.js indicator, Vite/webpack error overlays, Astro/Nuxt toolbars, TanStack devtools) are hidden automatically; if one was *showing an error*, that's reported as a warning instead. |
| `colorSchemes` | `["light"]` by default. Add `"dark"` if the app supports it. |
| `storageState` | Playwright auth state for pages behind login (see below). |
| `checks` | Possible-bug checks run on every capture; only problems that are on head and not on base are reported. `false` turns them all off. Otherwise an object: set any of `textClipping` (text cut off by overflow, ellipsis or line clamp), `pageOverflow` (sideways scroll), `overlap` (text/controls overlapping), `offscreen` (controls pushed out of view or squashed to 0), `tapTargets` (under 24×24px, mobile viewports only), `a11y` (axe-core WCAG 2 A/AA rules) to `false`; `ignore`: selectors whose elements (and descendants) are skipped (`mask` selectors are skipped too); `ignoreRules`: axe rule ids to skip. Color contrast is always measured by the style diff instead of axe. |
| `clock` | When page clocks start: an ISO date (`"2025-06-01T12:00:00Z"`) or ms timestamp, to pin dates for good; `false` to use the real clock. Default: the moment the run starts, the same on base and head, so dates and "5 minutes ago" match. Time keeps running from there, so timers and debounce work. |
| `seedRandom` | `Math.random` returns the same sequence on base and head (default). `false` to leave it random. `crypto` random values aren't seeded. |
| `recheck` | Changed pages are loaded on base a second time, and whatever differs between the two loads is ignored as noise (default). The pixels show blue in the diff image; `results.json` items get `unstable: { pixels, ignored }`, or `{ sizeChanged: true }` when base doesn't even keep its height. `false` to skip it and save the extra captures. |
| `post` | Default destination: `"comment"`, `"description"` or `"manual"`. |
| `requireApproval` | `true` if the repo gates UI changes on a design sign-off (the Action's `require-approval` with `ui-diff-approve.yml`). The agent then passes `--approval` to `comment.cjs`, which adds a "Design approved" box tied to the head commit. |
| `animate` | `false` to skip the animated before ⇄ after image of each changed area (an APNG that flips between a grey "BEFORE" and a violet "AFTER" frame). On by default; the comment then shows the animations first and folds the still before/after pairs into a collapsed block. `comment.cjs --no-animate` drops them from one comment only. |
| `storybook` | `true` to always diff Storybook stories instead of pages (see `route-mapping.md`), or an object with any of: `dir` (package holding `.storybook/`, e.g. `"packages/ui"`), `command` (with `{port}`; default: the `storybook` script, else `storybook dev -p {port} --ci`), `stories` (ids always captured, `*` allowed), `viewports` (default 1024×768 + iPhone 13; top-level `viewports` are for pages), `max` (cap on picked stories, default 40). `mask`, `hide`, `css` and `colorSchemes` apply to stories too. |

## Pages behind login

Create a saved session once, then point `storageState` at it:

```bash
npx --prefix ~/.cache/ui-diff playwright codegen --save-storage=.ui-diff/auth.json http://localhost:3000/login
```

Log in in the window that opens, then close it. `.ui-diff/` is git-ignored locally by the
skill, but double-check before committing anything: this file holds session cookies.

Use a test account with fake data. Screenshots of logged-in pages get pushed to the assets
branch, and in a public repo that makes them public.

## Noise control

Dates, `Math.random` and content that changes on every load are handled automatically (see
`clock`, `seedRandom` and `recheck` above). If an unchanged page still shows up as changed,
it's almost always one of:
- **Dynamic data** (times, random ids, live API data) → add to `mask`.
- **Lazy images/fonts still loading** → add `waitFor` on the route or raise `settleMs`.
- **Carousels / auto-playing video** → `hide`, or `actions` to pause.
- **Different data in base vs head** (e.g. a migration in the PR) → expected; say so in the summary.
