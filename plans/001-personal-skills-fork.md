# Skills discovery, likes, and installation history

Extend the existing CLI through source-less `skills add`. Keep `skills add <source>`, `find`, the welcome screen, providers, installation behavior, and lockfile formats compatible with upstream.

| Field    | Value                                                       |
| -------- | ----------------------------------------------------------- |
| Status   | DONE                                                        |
| Baseline | `13e4063a1cf913f5606d57d42ab83a86f5001e04` (`skills@1.7.2`) |
| Branch   | `feat/personal-skills`                                      |
| Checkout | `/Users/vladikopl/code/projects/skills-cli`                 |
| Updated  | 2026-10-18                                                  |

## Behavior

- `skills add` opens four tabs: Search, Liked, Most installed, and Your most installed. The first tab searches skills.sh; the third uses its all-time leaderboard. Personal likes and history remain available offline.
- Tab switches views, arrows navigate, Space selects or deselects in every tab, Enter installs, Ctrl+L likes/unlikes, and Esc cancels. Ctrl+P (previous) and Ctrl+N (next) browse Search in 20-result pages. Each tab preserves its query, cursor, and page. Ctrl+D opens a scrollable SKILL.md preview; Esc returns without losing the query or selection. Rows show source, counts, and installation status inline. Most installed is a bounded top-skills list; broader discovery belongs in Search. Selection carries across pages, searches, and tabs and deduplicates by source and skill identity. Liking a search result saves it immediately without installation.
- Ask for agents, scope, and method once per selection, using existing add helpers and agent preferences. Keep the existing summary, overwrite confirmation, and explicit command flags.
- Personal state starts empty, is shared across projects, and remains local. Do not import installations or ecosystem counts into personal history. No tags, accounts, synchronization, or project-specific collections.
- Sort personal history by descending installation count and alphabetically for ties. Show current project/global status from those folders and lockfiles, without scanning other projects.
- Increment once per explicit skill selection after all requested agent/subagent targets succeed and at least one target writes files. Multiple agents still count once; explicit reinstalls count again. Updates, sync, failures, and no-ops do not count. Uninstall preserves likes and counts.
- Continue independent installations after failures. Offer retries for incomplete work, retaining completed targets and counting a recovered skill only once.
- Keep ordinary `like [source]`, `list --saved`, `--liked`, and explicit saved selections for scripts. Default installed-list JSON remains unchanged; installation JSON still requires a source.

## Implementation

| Module                         | Responsibility                                                               |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `src/add.ts`                   | Existing source add flow and shared installation helpers                     |
| `src/add-saved.ts`             | Source-less entry point, shared settings, multi-source installation, retries |
| `src/add-source.ts`            | Shared source preparation and cancellable SKILL.md previews                  |
| `src/prompts/skill-browser.ts` | Four-tab discovery and selection prompt                                      |
| `src/skills-api.ts`            | Validated skills.sh search and all-time leaderboard responses                |
| `src/saved-skills.ts`          | Like command, saved lists, source-aware installed indicators                 |
| `src/personal-catalog.ts`      | Durable source identities, likes, counters, atomic local persistence         |
| `src/personal-history.ts`      | Observe completed explicit installs without changing installation outcomes   |

Search extends its result limit on demand because the API ignores page and offset parameters. Merge by source and skill, preserving existing row order and selections when API ranking changes. Cache fetched pages for backwards navigation, and stop when the API returns fewer results than requested.

Keep source-based add multiselect behavior unchanged; share text wrapping with the preview. Reuse current installers, discovery, providers, prompts, and lock persistence. Do not add dependencies or send personal metadata in telemetry. Accept older state containing tags while preserving its likes and counts; subsequent writes use the smaller schema.

## Milestones

| Milestone                                                      | Status |
| -------------------------------------------------------------- | ------ |
| Local state, explicit-install counters, maintenance exclusions | DONE   |
| Shared installation settings and partial failure retries       | DONE   |
| Four-tab source-less add and search-result likes               | DONE   |
| Remove tags and integrate documentation with existing sections | DONE   |
| Full verification and package review                           | DONE   |

## Verification

Use isolated temporary homes and projects for all installation checks. Run focused tests for discovery validation, tab navigation, zero-install likes, separate ecosystem/personal counts, cross-tab deduplication, offline behavior, request cancellation, source identity, persistence, and retry accounting. Existing source-add, provider, JSON, installer, update, and sync tests must pass unchanged in behavior.

Before readiness, run types, formatting, the full test suite, build, help/version, and package inspection. Execute the extracted package and test the built interactive flow through a real terminal. Do not use a browser, start a development server, or install into the user's own agent directories.

Verified after the full upstream diff review on 2026-10-17 using Node 24.19.0 and pnpm 10.17.1:

- `pnpm type-check` and `pnpm format:check` passed.
- `pnpm test --run`: **1,037 tests passed across 76 files** in an isolated parent home. Log: `/private/tmp/skills-cli-maintainer-tests.log`.
- `pnpm build` passed with a temporary home and npm cache. Log: `/private/tmp/skills-cli-maintainer-build.log`. The existing ineffective dynamic import warning for `blob.ts` remains.
- Archive `/private/tmp/skills-cli-pages-package-6AlXBS/skills-1.7.2.tgz` contains 23 files, executable entrypoint, bundled chunks, README, license, and notices. It contains no source, tests, plans, or personal state. Extracted-package execution passed help/version/welcome, empty-state read, like-before-install, saved installation/counts, and unchanged installed-list JSON. Log: `/private/tmp/skills-cli-maintainer-package.log`.
- Nine source-command scenarios produced identical stdout, stderr, and exit status against the pinned upstream snapshot: source listing, project install and reinstall, project/global JSON installs, plain/JSON invalid-agent errors, a missing source, and installed-list JSON. Installed fixture files also matched. Log: `/private/tmp/skills-cli-maintainer-parity.log`.
- The built CLI passed a real terminal check using an isolated home and project: Space selected skills on pages 1 and 2; Ctrl+P/N changed pages; tab changes restored query/page/cursor; clearing and repeating the search showed both skills selected again; confirmation installed exactly those two skills despite a different, unselected row being highlighted. Both personal counts increased to one. Harness: `/private/tmp/skills-cli-pages-terminal.mjs`. Test homes and installed fixtures were removed afterwards.
- Picker coverage includes pagination, cached backwards navigation, partial pages, cross-tab/search selections, ranking changes, failed-page retries, stale responses, cancellation, and compact terminals. New checks verify a shared row width budget and saved branch/ref previews that retain ecosystem counts.
- Standards review: picker rows retain their discovery/personal types and reuse saved filtering; rendering computes the visible rows once. Catalog locking no longer needs a separate recovery lock, and tests cover abandoned and empty locks. Source preparation, summaries, providers, and installers continue to use existing helpers. No dependencies were added.
- Spec review: restored upstream invalid-agent output and exception propagation for explicit sources. Continuing after unexpected target failures is limited to saved selections; successful targets survive retries and count once. Existing source-add, provider, JSON, update, sync, likes, and preview behavior passed the full suite.
- Live API probes confirmed page and offset parameters return the first page, while larger limits return more results. Search grows its limit on demand and merges results without discarding earlier rows or selections; find retains its default 20-result request.
- `git diff --check` passed. The low-level installer, source parser, both lockfile schemas, dependency lockfile, and executable wrapper have no changes.

Linux/Windows and live authenticated providers were not exercised. No browser, development server, publication, or installation into the user's agent folders was used.

## Release

Implementation uses the source checkout and the `feat/personal-skills` branch in [vladikopl01/skills-cli](https://github.com/vladikopl01/skills-cli), a fork of `vercel-labs/skills`. No worktree is used. Keep `private: true` and the publish job disabled until a package name is chosen and release is authorized. Pushing the GitHub fork does not publish a package.
