# Tidepool: ui-diff demo app

A small Vite + React + React Router app used to show what ui-diff posts on a pull request.
It is **not part of the skill**: `npx skills add`, `install.sh` and the manual copy install
only `skills/ui-diff/`, and `.gitattributes` keeps this folder out of release tarballs.

Pages: `/` (landing), `/pricing`, `/dashboard`, `/settings`. Light and dark themes follow
`prefers-color-scheme`, and the layout changes under 860px and 640px.

```bash
cd examples/demo-app && npm ci && npm run dev
```

## Opening an example PR

Any PR that touches `examples/demo-app/**` runs `.github/workflows/demo.yml`, which uses this
checkout's action (`uses: ./`) with the root `.ui-diff.json` (desktop + iPhone 13, light + dark).
Routes are picked from the changed files.

Ideas for example PRs, each showing a different part of the report:

| Change | What the comment shows |
|---|---|
| `--radius: 12px` → `20px` in `src/styles.css` | an app-wide style change measured on every page |
| New headline in `src/pages/Pricing.jsx` | a copy change on one page |
| `--muted` in light mode → `#a0aba9` | a color-contrast drop flagged as a possible bug |
| `white-space: nowrap` on `.stat-delta` | text clipping / sideways scroll on mobile |
| Add a `/changelog` page in `src/router.jsx` | a new page (head only) |
| Swap the order of the two hero buttons | a layout move with no style change |
