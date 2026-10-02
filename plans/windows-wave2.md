# Windows wave 2 — Squirrel preview

Start from: `origin/codex/win-electron`, merged with `origin/main`.

## Contract

Ship an unsigned per-user Squirrel Setup, RELEASES, full nupkg and portable ZIP.
Reuse Settings → Updates discovery and preview rules. Stage and SHA-256 verify
the selected nupkg, drain the foreground Agent, apply with the installed
Update.exe, and relaunch the exact App/Agent version with the same DATA.
Squirrel owns version directories, rollback retention and uninstall integration.
Never run registration or installer tests on the owner's Windows host.

## Implementation and acceptance

- [ ] Package exact preview versions and prove Squirrel's numeric preview ordering.
- [ ] Connect the existing App update helper to Squirrel; preserve drain/cancel.
- [ ] Explicitly disable all shell registration in portable smoke.
- [ ] Disposable Windows smoke: silent install, shortcuts/protocol/AUMID,
  tray/login toggle/notifications/deep link, authenticated health and stub chat,
  Settings Update to preview.91, exact replacement Agent and preserved DATA,
  previous version retained, uninstall cleans shell registration and retains DATA.
- [ ] Release job consumes agent-windows artifact; publish successful platforms,
  merge App update manifests once and include Windows checksums.
- [ ] Korean/English install, unsigned SmartScreen, update and uninstall docs.
- [ ] Isolated local checks, native Windows portable loop, then Windows CI.

## Verification boundary

The owner's PC is a build host only: private task worktree and target, isolated
HOME/DATA/APPDATA/LOCALAPPDATA, registration disabled, protocol registry checked
before/after, exact owned PIDs stopped. Install/update/uninstall and shell effects
run only on GitHub's disposable windows-latest runner. No live model calls.
