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

- [x] Package exact preview versions and prove Squirrel's numeric preview ordering.
- [x] Connect the existing App update helper to Squirrel; preserve drain/cancel.
- [x] Explicitly disable all shell registration in portable smoke.
- [ ] Disposable Windows smoke: silent install, shortcuts/protocol/AUMID,
  tray/login toggle/notifications/deep link, authenticated health and stub chat,
  Settings Update to preview.91, exact replacement Agent and preserved DATA,
  previous version retained, uninstall cleans shell registration and retains DATA.
- [x] Release job consumes agent-windows artifact; publish successful platforms,
  merge App update manifests once and include Windows checksums.
- [x] Korean/English install, unsigned SmartScreen, update and uninstall docs.
- [x] Isolated local checks and native Windows portable loop.
- [ ] Final disposable Windows installer/update/uninstall CI.

## Verification boundary

The owner's PC is a build host only: private task worktree and target, isolated
HOME/DATA/APPDATA/LOCALAPPDATA, registration disabled, protocol registry checked
before/after, exact owned PIDs stopped. Install/update/uninstall and shell effects
run only on GitHub's disposable windows-latest runner. No live model calls.

## Evidence

Native Windows clippy/release build: 296.967 seconds. Portable health/reload,
stub chat (two ordered messages), five owned process exits, port release and
unchanged owner protocol all passed. Squirrel comparer proves preview.9 <
preview.10 < stable. Local frozen Bun/check, platform clippy/fmt/source-check,
28 existing Bun tests (119 assertions), two process-role E2Es and docs passed.

CI run 36966939910 built both preview.90/preview.91 packages and passed all
five existing Windows update/channel/process-role E2Es. Ordinary Setup launch
and reload, silent install shell links/AUMID/protocol, exact App/Agent, stub
chat passed. Shell-feature verification lost CDP while the runtime remained
ready. The smoke used DOM window.close instead of the product close button; the fresh disposable rerun will use that real UI path
and retain the complete tray, notification, deep-link, update and uninstall
assertions. Packages are reusable only after the workflow proves all product
sources match their producing revision.

Latest Linux packaging and macOS packaged App update passed. Separate macOS
stub E2E failures remain tracked in #437 and #442; no assertions or timeouts
were weakened. Source checks retain the baseline. No release tag was created.
