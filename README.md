<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/header-dark.png">
    <img src="docs/brand/header-light.png" alt="ui-diff: see what a pull request looks like. Before/after screenshots, pixel diffs and measured style changes, posted to the PR." width="880">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/davidamunga/ui-diff/actions/workflows/test.yml"><img src="https://github.com/davidamunga/ui-diff/actions/workflows/test.yml/badge.svg" alt="test"></a>
  <a href="https://github.com/davidamunga/ui-diff/releases/latest"><img src="https://img.shields.io/github/v/release/davidamunga/ui-diff?color=7c3aed" alt="latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-7c3aed" alt="MIT license"></a>
  <a href="https://agentskills.io"><img src="https://img.shields.io/badge/Agent%20Skill-compatible-7c3aed" alt="Agent Skill"></a>
</p>

Reviewers can read a CSS diff, but they can't see it. **ui-diff** runs your app at the PR's
base and head, screenshots the pages the change touches, and posts a before/after comment
with the exact style changes measured, so designers and reviewers see what actually changed.

It's an [Agent Skill](https://agentskills.io) for Claude Code, Codex, Cursor, GitHub Copilot,
Gemini CLI, OpenCode, Goose, Windsurf, Amp and other compatible agents, and a GitHub Action
for CI.

<p align="center">
  <img src="docs/demo.png" alt="A ui-diff comment on a pull request: a written summary of the design changes, then before/after crops showing the buttons turning from blue rectangles into violet pills" width="720">
</p>

## Contents

- [What it does](#what-it-does)
- [Install](#install)
- [Use](#use)
- [Run in CI](#run-in-ci)
- [Configure](#configure)
- [Where the images go](#where-the-images-go)
- [Development](#development)

## What it does

- **Finds the affected pages** from the changed files: it reads your framework's routes (Next.js, SvelteKit, Nuxt, Astro, Remix/React Router, plain HTML) and follows imports from changed components, through aliases and workspace packages, to the pages that use them.
- **Renders base and head side by side** in git worktrees on free ports. Your checkout and your other running servers are left alone.
- **Screenshots** each page on desktop and an emulated iPhone (dark mode optional), with animations frozen so the shots are reproducible.
- **Shows each change as an animation** that flips between before and after, inline in the PR comment, with the still pair one click away.
- **Measures** every element's computed styles: `padding 8px 14px → 12px 20px`, `#2563eb → #7c3aed`, layout shifts, copy changes and new WCAG contrast failures.
- **Flags likely bugs the PR introduces:** clipped text, sideways scrolling on mobile, overlapping elements, controls pushed off-screen, tap targets that are too small, and accessibility violations (axe-core). Problems that already existed on base aren't reported.
- **Writes a design summary** from those measurements, leading with what looks unintended.
- **Posts it to the PR** as a comment or a section of the description. Re-runs update it instead of adding new ones.
- **Can gate the merge on a design sign-off:** a `ui-diff/design-review` check stays pending until someone with write access ticks "Design approved" in the comment.

It also works on **Storybook** stories, compares the result against a **Figma** frame you
link, and writes a local review page with a before/after slider.

## Install

Pick the line for the tool you use. They all install the same skill.

| You use | Run |
|---|---|
| **Claude Code** | `/plugin marketplace add davidamunga/ui-diff`<br>`/plugin install ui-diff@ui-diff` |
| **Any other agent** (Codex, Cursor, Copilot, Gemini CLI, OpenCode, …) | `npx skills add davidamunga/ui-diff -g` |
| **Several agents**, kept in sync with one clone | `git clone https://github.com/davidamunga/ui-diff.git`<br>`./ui-diff/install.sh` |
| **CI only**, no agent | the GitHub Action: see [Run in CI](#run-in-ci) |

Then **start a new agent session** (skills are loaded when a session starts) and ask
something like *"show me the UI changes on this branch"*.

**Requirements:** macOS or Linux, bash, git, Node.js 18+, and the [GitHub CLI](https://cli.github.com)
(`gh`, logged in) to post to PRs. Plain-HTML sites also need python3. The first run downloads
Playwright and Chromium (about 150 MB) into `~/.cache/ui-diff`; your project's dependencies
aren't touched.

<details>
<summary><b>Claude Code</b> plugin details</summary>

Run these inside Claude Code:

```
/plugin marketplace add davidamunga/ui-diff
/plugin install ui-diff@ui-diff
```

To update later: `/plugin marketplace update ui-diff`, then `/plugin update ui-diff@ui-diff`.
To remove: `/plugin uninstall ui-diff@ui-diff`.

</details>

<details>
<summary><b>skills</b> CLI details (any agent)</summary>

The [`skills`](https://skills.sh) CLI (needs Node 22.20+) knows where each agent keeps its skills.

```bash
npx skills add davidamunga/ui-diff -g                        # for your user; asks which agents
npx skills add davidamunga/ui-diff -g -a codex -a cursor     # name the agents
npx skills add davidamunga/ui-diff                           # this project only
```

To update, run the same `add` command again.

</details>

<details>
<summary><b>install.sh</b> details (every agent on the machine, from a clone)</summary>

```bash
git clone https://github.com/davidamunga/ui-diff.git && cd ui-diff
./install.sh                          # link into every agent it finds
./install.sh --list                   # show agents, their skills folders, and what's installed
./install.sh --agents codex,cursor    # only these agents
./install.sh --project ~/Work/my-app  # one project only (my-app/.agents/skills/)
./install.sh --agents claude          # Claude Code as a plain skill instead of the plugin
./install.sh --copy                   # copy instead of symlink
./install.sh --uninstall              # remove what it installed
```

It symlinks by default, so `git pull` in the clone updates every agent at once. It never
touches an existing `ui-diff` folder it didn't create.

</details>

<details>
<summary><b>Manual</b> install (copy the folder yourself)</summary>

Copy or symlink `skills/ui-diff/` into your agent's skills folder:

| Agent | For your user | For one project |
|---|---|---|
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| Codex, Cline | `~/.agents/skills/` | `.agents/skills/` |
| Cursor | `~/.cursor/skills/` | `.agents/skills/` |
| Gemini CLI | `~/.gemini/skills/` | `.agents/skills/` |
| GitHub Copilot | `~/.copilot/skills/` | `.agents/skills/` |
| OpenCode | `~/.config/opencode/skills/` | `.agents/skills/` |
| Goose | `~/.config/goose/skills/` | `.goose/skills/` |
| Windsurf | `~/.codeium/windsurf/skills/` | `.windsurf/skills/` |
| Amp | `~/.config/agents/skills/` | `.agents/skills/` |

</details>

## Use

Ask your agent in plain words, on a branch with UI changes:

> add before/after screenshots of my UI changes to the PR

> did my tailwind config change break any pages? check desktop and mobile

> ui diff for PR #482, put it in the description

> show the Button changes in Storybook

> does /pricing match the design? https://www.figma.com/design/AbC123/App?node-id=12-34

The agent works out which pages to check, runs the comparison (usually under a minute),
shows you the summary, and asks before posting anything to the PR. Results stay in
`.ui-diff/report/`, including `index.html`, a review page with a before/after slider,
side-by-side view and diff overlay.

- **Storybook:** in projects with Storybook, the agent can compare the stories affected by the change instead of whole pages.
- **Figma:** the agent uses its Figma tool (such as the Figma MCP server) if it has one, otherwise the Figma REST API with a `FIGMA_TOKEN`. See [`figma.md`](skills/ui-diff/references/figma.md).
- **Pages behind a login:** save a Playwright `storageState` for a test account and point `.ui-diff.json` at it. See [Configure](#configure).

## Run in CI

The same pipeline runs as a GitHub Action on every push to a PR, with no agent. Copy
[`examples/workflows/ui-diff.yml`](examples/workflows/ui-diff.yml) into `.github/workflows/`:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: write        # push screenshots to the ui-diff-assets branch
  pull-requests: write   # add / update the PR comment
jobs:
  ui-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
      - run: npm ci          # your project's install step
      - uses: davidamunga/ui-diff@v0
        # with:
        #   routes: /,/pricing   # optional: picked from the changed files otherwise
```

How it differs from running it through an agent:

- **Routes come from the diff by rule, not judgement.** With no `routes` input and none in `.ui-diff.json`, [`routes.cjs`](skills/ui-diff/scripts/routes.cjs) picks them from the changed files: changed pages, routes under changed layouts, pages importing changed components (through aliases and workspace packages), and home plus a few well-linked pages for global styles. The log says why each was picked. Dynamic routes need example values (`routeParams` in `.ui-diff.json`). A PR that changes no page-affecting files is skipped; one where no route can be found fails and says so. Set `auto-routes: false` to require routes.
- **The summary is automatic**, built from the measured changes and labelled as such. To use your own, write a Markdown file in an earlier step and pass it as `summary`.
- **You install dependencies** with your own step before the action. Head reuses them; base reuses them when the lockfile matches and installs in its own worktree otherwise.
- **Fork and Dependabot PRs are skipped** with a log line, because GitHub gives them a read-only token. Don't work around this with `pull_request_target`: that runs the PR's code with a write token.

To remove a PR's images when it closes, add
[`examples/workflows/ui-diff-cleanup.yml`](examples/workflows/ui-diff-cleanup.yml) (it runs
the action with `mode: prune`).

### Design review gate

Opt in with `require-approval: true` to make UI changes need a sign-off before merge. The
action then sets a `ui-diff/design-review` commit status on the PR head:

- **Visual changes** (changed, new or removed pages, or pages that failed to capture) →
  `pending` ("2 pages changed — needs design review"), linking to the comment, which gets a
  `- [ ] **Design approved**` box.
- **No visual changes** → `success`.
- **The run fails** → no status is set. If the check is required, the PR stays blocked
  ("Expected — waiting for status") until a run succeeds: it fails closed.

Someone with write, maintain or admin access approves by **ticking the box** (or adding the
`design-approved` label, set with `approval-label`). That needs a second workflow,
[`examples/workflows/ui-diff-approve.yml`](examples/workflows/ui-diff-approve.yml), which
runs the action with `mode: approve`. It sets the status to `success` ("Approved by @them")
and adds "✅ Approved by @them for `abc1234`" under the box. Unticking or removing the label
puts it back to `pending`. Ticks from users without write access, and edits by the bot itself,
are ignored.

Approval belongs to one commit. The comment records the sha it was rendered for, and a
tick only counts while that sha is still the PR head. A new push with visual changes sets
the new commit to `pending`, renders an unticked box and removes the label. A re-run on an
already-approved commit keeps the approval.

To block merging until then, add `ui-diff/design-review` as a required status check in the
branch protection rule (or ruleset) for your default branch. It shows up in the list once
it's been reported on a PR. Add `statuses: write` to `ui-diff.yml`'s permissions; the
approve workflow needs `statuses: write`, `pull-requests: write` and `issues: write`.

- **Security:** `issue_comment` workflows always run the default branch's workflow file
  with a write token. `mode: approve` never checks out or runs PR code. It reads the event
  payload and calls the GitHub API, so keep the approve workflow free of checkout and build
  steps.
- **Forks:** the main run skips fork PRs (read-only token), so they get no comment and no
  status, and a required check blocks them. Ticking a box works on fork PRs, because
  `issue_comment` runs with the base repo's token. The box only exists if the comment was
  posted some other way, e.g. by an agent with `requireApproval`. Label approval on fork
  PRs fails: the `pull_request` event gives them a read-only token too.
- **Description mode** has no box; approve with the label.
- **Self-approval** is allowed: a PR author with write access can tick their own box.

<details>
<summary>All inputs and outputs</summary>

| Input | Default | |
|---|---|---|
| `routes` | from the diff | Comma-separated, e.g. `/,/pricing`. Added to `.ui-diff.json`'s routes. |
| `auto-routes` | `true` | Pick routes from the changed files when none are given. `false` requires them. |
| `dev-command` | detected | Starts the app; `{port}` is replaced with the port. |
| `viewports` | `desktop:1440x900,mobile:iPhone 13` | |
| `color-schemes` | `light` | e.g. `light,dark` |
| `mode` | `comment` | `comment`, `description` (a section of the PR description), `prune`, or `approve` (the approve workflow) |
| `working-directory` | `.` | Where the repo is checked out, if you used `path:` with checkout. |
| `base` | the PR's base commit | |
| `config` | `.ui-diff.json` | |
| `summary` | automatic | Markdown file to use as the summary. |
| `assets-branch` | `ui-diff-assets` | |
| `server-timeout` | `180` | Seconds to wait for each dev server. |
| `require-approval` | `false` | `true`: set the `ui-diff/design-review` status and add an approval box (see [Design review gate](#design-review-gate)). |
| `approval-label` | `design-approved` | Label that also approves. Use the same value in the approve workflow. |
| `github-token` | `github.token` | |

Outputs: `changed`, `added`, `removed`, `unchanged`, `errors`, `comment-url`, `report-dir`,
and `skipped` (`true` for fork and Dependabot PRs). Playwright and Chromium are cached
between runs, and Chromium's system libraries are installed on Linux runners when missing.
The example workflow also uploads `.ui-diff/report` and the server logs as an artifact.

</details>

## Configure

Everything is optional. To save the routes, dev command and other settings for next time,
add a `.ui-diff.json` at the repo root (the agent offers to write it after a run):

```json
{
  "devCommand": "pnpm dev --port {port}",
  "routes": ["/", "/pricing", { "path": "/settings", "waitFor": "[data-testid=form]" }],
  "colorSchemes": ["light", "dark"],
  "mask": ["[data-testid=timestamp]"],
  "storageState": ".ui-diff/auth.json"
}
```

[`config.md`](skills/ui-diff/references/config.md) lists every option: viewports and devices,
clicks and other steps before a screenshot, masking and hiding noisy content, logins,
Storybook and Figma settings.

## Where the images go

GitHub has no public API for the drag-and-drop image uploads you use in comments, so
ui-diff pushes the images to a `ui-diff-assets` branch in the same repo and links them from
there. They render inline, and in private repos only people with read access can see them.

- The branch is kept as a single commit, so it doesn't bloat clones.
- `scripts/prune.sh <pr>` or the [cleanup workflow](#run-in-ci) removes one PR's images. `UI_DIFF_PRUNE=1` removes the images of every closed PR on the next publish. You can also delete the branch at any time.
- **In a public repo the screenshots are public.** The agent tells you before posting. Be careful with pages behind a login.
- **Manual mode:** if you can't push to the repo (a PR from a fork), or would rather not have the branch, ask for manual mode. The agent writes the comment and opens the image folder, and you drag the images into GitHub yourself.

## Development

```bash
tests/selftest.sh          # ~30s: unit checks + the full pipeline on a fixture site (no network)
tests/selftest.sh --full   # ~1 min more: also a real Vite + React app and a real Storybook
tests/selftest.sh --keep   # keep the temp repos for inspection
```

The fast tier builds throwaway git repos from `tests/fixtures/` and checks what the skill
promises: measured style, copy and contrast changes, new and unchanged pages, no false
positives on a non-visual change, labelling of uncommitted changes, publishing and pruning
against a local bare remote, the automatic summary, the Action's script with a fake PR event,
and that servers and worktrees are cleaned up while unrelated processes are left alone.
Nothing touches GitHub. CI runs the full tier on Ubuntu and macOS for every push and PR.

- **Trigger evals:** [`evals/`](evals/README.md) holds prompts that should and shouldn't make an agent load the skill.
- **Releasing:** `scripts/release.sh 0.3.0 [notes.md]` bumps the version in `plugin.json` and `SKILL.md`, runs the tests, tags `v0.3.0`, moves `v0` (what `uses: davidamunga/ui-diff@v0` follows) and creates the GitHub release.
- **Brand assets:** the logo and header come from the [UI Diffs Figma file](https://www.figma.com/design/Wlx6ycTYRVkzCQ4sdRMLb8/UI-Diffs?node-id=0-1). See [`docs/brand/`](docs/brand/README.md).

<details>
<summary>Repository layout</summary>

```
install.sh                      install for every detected agent
action.yml                      GitHub Action (runs action/ci.sh)
action/ci.sh                    the pipeline with no agent: run → publish → comment → post, or prune
examples/workflows/             workflows to copy: ui-diff.yml, ui-diff-cleanup.yml, ui-diff-approve.yml
examples/demo-app/              sample React app for example PRs (not installed with the skill)
skills/ui-diff/
├── SKILL.md                    the workflow the agent follows
├── LICENSE.txt                 MIT (a copy that travels with the skill folder)
├── scripts/
│   ├── run.sh                  the whole pipeline: worktrees → servers → capture → diffs
│   ├── setup.sh                one-time toolchain install
│   ├── devcmd.cjs              detect the dev-server command and port flag
│   ├── linkdeps.cjs            reuse installed deps in a worktree without sharing build caches
│   ├── routes.cjs              changed files → routes to capture (per framework)
│   ├── imports.cjs             import graph shared by routes.cjs and stories.cjs
│   ├── stories.cjs             Storybook mode: changed files → stories to capture
│   ├── capture.cjs             deterministic screenshots + computed-style snapshots
│   ├── diff.cjs                pixel diff, changed regions, zoom crops
│   ├── stylediff.cjs           measured style/layout/copy/contrast changes
│   ├── figma-export.cjs        export a Figma frame as PNG (REST API, FIGMA_TOKEN)
│   ├── compare.cjs             design vs implementation: composite, regions, zooms
│   ├── viewer.cjs              local before/after review page (index.html)
│   ├── publish.sh              push images to the assets branch
│   ├── prune.sh                remove a closed PR's images from it
│   ├── assets.sh               shared by both: throwaway clone, single-commit push
│   ├── comment.cjs             render the PR markdown
│   ├── post.cjs                create or update the PR comment / description section
│   └── review.cjs              design review gate: commit status, approve by box or label
└── references/
    ├── route-mapping.md        changed files → routes (and stories), per framework
    ├── config.md               .ui-diff.json options, auth, noise control
    └── figma.md                comparing with a Figma design
tests/                          selftest.sh, spec check, fixtures
evals/                          trigger evals
docs/                           demo image, brand assets (from Figma)
scripts/release.sh              cut a release
```

</details>

## License

MIT. See [LICENSE](LICENSE).
