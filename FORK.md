# Maintaining this fork

`origin` is your fork; `upstream` is `https://github.com/pingdotgg/t3code.git`.
Keep bridge changes as small commits on `fork/codex-sync`. Most code lives under
`apps/server/src/codexDesktop`; integration changes are limited to contracts,
RPC authorization, client atoms and the Codex Desktop page. Usage and acceptance
steps are in [docs/codex-desktop.md](docs/codex-desktop.md).

## Pull upstream changes

Commit local work, then run:

```powershell
./scripts/fork-upstream-sync.ps1
```

This fetches upstream and prepares a merge on `sync/upstream-<commit>` in a new
sibling worktree. Your working branch stays in place. Conflicts remain in that
isolated worktree for resolution. Install dependencies there, run
`vp run check:changed fork/codex-sync`, then repeat desktop acceptance. When the
candidate passes, fast-forward the fork branch to the candidate and push it.
Keep merge commits so Git remembers which upstream changes are integrated.

The **Fork upstream candidate** workflow checks daily and can also run manually.
It pushes a candidate branch and validates it on a standard Windows runner; it
does not create a PR, merge, publish or install a release. GitHub schedules run
only from the default branch: set the fork's default branch to `fork/codex-sync`
after publishing it, or merge these changes into your existing default branch.
Enable Actions on the fork. Check the workflow results after the first run;
repository Actions policy may require enabling the pinned Vite+ setup action.

The separate **Fork Codex Desktop checks** workflow runs on pushes to the bridge
branch. Neither workflow requires upstream's private cache or paid runners.
Upstream's own workflows remain intact.

## Build and update your Windows app

```powershell
./scripts/fork-build-windows.ps1
```

The wrapper derives the update repository from your fork's `origin` and sets
`T3CODE_DESKTOP_UPDATE_REPOSITORY` for the build. Publish tested release artifacts
to that fork when ready. This keeps an upstream release from replacing the bridge
through the app updater. Source synchronization and installing a release are
separate steps. Do not point this build at the official upstream update feed.

Updating Codex Desktop may also change its private IPC protocol. Repeat the
shared-conversation checks in addition to upstream merge checks before upgrading
your daily installation. Keep the previous fork installer for rollback.
