# Operating the Codex Desktop fork

## Local workspace and data

Keep source, toolchains, disposable acceptance data and build artifacts in separate
directories chosen for the machine. Do not commit credentials, session history,
local configuration, private caches or machine-specific acceptance reports.
Use a disposable T3 home when testing, rather than the installed user's live data.
After moving a workspace, reinstall dependencies to rebuild machine-local links.

## Building Windows installers

Use `scripts/fork-build-windows.ps1` from a configured checkout. It selects the
fork's update repository, so upstream updates do not replace the bridge.
Install the prerequisites documented in
[development.md](development.md#windows-installer-prerequisites).
Never assume an unsigned installer is signed merely because CI built it.

The independent Windows snapshot workflow uses standard GitHub-hosted runners
and uploads an unsigned x64 installer and SHA-256 manifest as temporary artifacts.
It does not publish a release, publish npm packages, install the application,
or activate the upstream synchronization workflow.

## Acceptance

Use disposable conversations and synthetic inputs. Verify:

- Existing Desktop history renders without altering native history files.
- Shared text, model and reasoning-effort changes follow the current owner.
- Handoff preserves native identity and avoids concurrent writers.
- Disconnect and resubscribe retain run and message identities.
- Desktop-origin events update T3; test title synchronization separately.
- Mobile and desktop clients reflect the same persisted conversation state.
- Idle history discovery does not block initial page loading.

A title saved in history is not proof that a running Desktop window refreshed.
Record protocol delivery and actual UI behavior separately. Preserve history and
configuration when cleaning up temporary test processes and sessions.
Use only the PIDs owned by the experiment.

## Upstream maintenance

Keep `origin` pointed at the fork and `upstream` at `pingdotgg/t3code`.
From a clean branch, `scripts/fork-upstream-sync.ps1` prepares a separate candidate
worktree. Review existing candidates before creating another one.
Resolve and validate in that worktree, run `vp run check:changed` against the
fork baseline, and repeat desktop acceptance before integration.

The optional candidate workflow is independent of installer builds. It must be
explicitly activated before scheduled synchronization can run.
