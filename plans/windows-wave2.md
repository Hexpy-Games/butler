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

The owner's self-hosted job builds only. SSH portable smoke uses a private task
worktree and target, isolated HOME/DATA/APPDATA/LOCALAPPDATA, registration disabled,
protocol registry checked before/after, and exact owned PIDs stopped.
Install/update/uninstall and shell effects run only on GitHub's disposable
windows-latest runner. No live model calls.

## Fast Windows pipeline

`windows-installer.yml` has only workflow_dispatch. BUILD on `[self-hosted,
butler-win]` creates preview.90 and preview.91 Agent/App packages and compiles the
five existing update/channel/process-role E2Es without executing them. VERIFY on
windows-latest consumes those artifacts, executes the E2Es and the full Squirrel
install/update/uninstall smoke. The release App job uses the same packaging
action; failed Windows jobs do not prevent successful other-platform publication.

Reuse `C:\Users\yeonw\work\target\win-installer` during iterations and the verified
`C:\Users\yeonw\work\ort-cache`. Keep isolated profiles short enough for NuGet.
Run portable smoke through `deploy/windows-portable-smoke.ps1`; its PowerShell
owner deletes the profile after Bun releases all file handles and restores the
parent environment. Windows PowerShell child commands discard inherited pwsh
module paths. Chat and background memory use strict stub responses; each is
asserted to make one successful provider call, with exact chat content/order/count.

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

Disposable run 36973557798 also passed login toggles, real close-to-tray,
notification show acknowledgement and registered deep-link restoration.
Settings then remained behind first-run consent: the fixture used version 1
while the product requires FIRST_RUN_CONSENT_VERSION (2). Use that existing
product constant, as the packaged macOS update smoke does.

Run 36974465477 reached the real Update button and the verified helper-ready
handshake, then the App remained ready. Navigation exposes its latest turn
state (delivered), but foreground quit omitted delivered from terminal states.
Recognize that completed state; retain active worker/turn and queued-message
protection. This product change requires new packaged bytes and native proof.
