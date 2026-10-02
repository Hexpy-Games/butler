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
- [x] Disposable Windows smoke: silent install, shortcuts/protocol/AUMID,
  tray/login toggle/notifications/deep link, authenticated health and stub chat,
  Settings Update to preview.91, exact replacement Agent and preserved DATA,
  previous version retained, uninstall cleans shell registration and retains DATA.
- [x] Release job consumes agent-windows artifact; publish successful platforms,
  merge App update manifests once and include Windows checksums.
- [x] Korean/English install, unsigned SmartScreen, update and uninstall docs.
- [x] Isolated local checks and native Windows portable loop.
- [x] Final disposable Windows installer/update/uninstall CI.

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
For harness-only iterations, optional `reuse-run` requires a successful BUILD
from this workflow/branch and proves every product and compiled E2E source is
identical. Only an explicit harness/workflow/document allowlist may differ;
all five E2Es and the entire installer smoke still execute on hosted Windows.

Reuse `C:\Users\yeonw\work\target\win-installer` during iterations and the verified
`C:\Users\yeonw\work\ort-cache`. Keep isolated profiles short enough for NuGet.
Run portable smoke through `deploy/windows-portable-smoke.ps1`; its PowerShell
owner deletes the profile after Bun releases all file handles and restores the
parent environment. Windows PowerShell child commands discard inherited pwsh
module paths. Chat and background memory use strict stub responses. Portable smoke asserts
one chat and one meaning call before exit. Installer smoke verifies one chat,
one meaning call for each user/assistant source, no repair or duplicate source,
and exact chat content/order/count. Meaning input batches cannot mix speakers.

## Evidence

Native Windows portable proof passed: authenticated health 200, exact preview.91,
reload, one stub chat and one meaning call, two ordered messages, delivered work
settled, five owned processes exited, port released and owner protocol unchanged.
Native platform clippy with `-D warnings`, both Agent/App package builds, forbidden
DLL dependency checks, Squirrel version comparer and relocated process-role E2Es
passed. Incremental Agent rebuilds took 7m50s and 3m44s (initial cold loop 28m09s).

Final hosted run [37035265489](https://github.com/Hexpy-Games/butler/actions/runs/37035265489)
is green at `97857abd1`. It verified all product and compiled E2E sources against
successful BUILD revision `1282a1f69` before downloading immutable packages.
Five existing E2Es passed: updates 1/21.75s, channels 2/32.68s, process roles
2/13.88s. Full installer proof took 174.029s: normal Setup auto-launch, silent
install, shell features, real Settings Update from preview.90 to preview.91,
exact App/Agent replacement and healthy Agent, retained chat/config/sentinel,
Squirrel rollback version, owned shutdown, uninstall removing shortcuts,
protocol and login registrations while keeping DATA. No leftover processes.
The strict provider recorded one chat and one extraction per user/assistant
source, with exact source text, no duplicate speaker and no schema repair.

| Run | BUILD wall | VERIFY wall | Result |
| --- | --- | --- | --- |
| 37021990416 | 11m38s | skipped | WinPS inherited pwsh module paths; fixed child environment |
| 37025617939 | 21m59s | 1m52s | Compiled checkout path in existing E2E; fixed workspace override |
| 37029595044 | 17m27s | 9m33s | Full product flow passed; incorrect global one-meaning assumption |
| 37035265489 | reused 17m27s BUILD | 7m37s | Green; explicit source equality guard and all hosted tests |

Final isolated local frozen Bun install and full `bun run check` passed.
`cargo fmt --all --check`, clippy `-D warnings` on touched platform/Agent/memory
crates and process-role E2E, and `cargo run -p butler-source-check -- .` from the
Rust workspace passed (2,192 Rust files; all ratchet/OS/architecture/E2E gates zero
violations). Existing focused Squirrel lifecycle tests passed (11 tests,
42 assertions). YAML parsing, publisher bash syntax, unchanged publisher command
order, Windows reuse-guard syntax and file line limits passed.
The earlier Bun doctor timeout was reported on existing issue #418; no timeout,
assertion or test was weakened. An incorrect source-check root rejected dependency
symlinks; the required Rust workspace scan passed.

Release uses the same packaging action and preserves successful-platform
publication when Windows fails. Tag-triggered release publication was not run;
no PR or release tag was created. Only the installer workflow was dispatched.
Task build targets on Mac/Windows are removed after delivery; ORT/build caches
remain. The final evidence-only commit changes no packaged or test source.
