Windows jobs build on `yw-pc` with labels `[self-hosted, butler-win]`.
Only same-repository PRs can reach it. Installer, protocol, lifecycle and LAN
verification runs on disposable `windows-latest` with compiled artifacts.
No self-hosted job may register protocols, services, login items, shortcuts,
credentials or firewall rules. A temporary profile does not isolate the registry.

Cargo targets, ORT, Bun, npm and NuGet caches live under
`github.workspace/target/windows-owner`, inside each runner's own `_work` tree.
Both `yw-pc` and `yw-pc-2` can build concurrently. Cargo's shared download cache
uses its own locks; installed Rust toolchains are read without updating them.
The pinned ORT recipe verifies archive and output hashes before reuse.
The compiler wrapper is cleared to avoid a shared sccache daemon/port.
Cleanup removes only the job's GUID profile under `RUNNER_TEMP` and checks the
owner's protocol key unchanged; it never deletes another job's target cache.
Workflow concurrency groups coalesce runs by ref, not by machine ownership.
Installer and Task Scheduler smokes remain on disposable hosted runners;
Squirrel resolves Windows known folders, so changing LOCALAPPDATA alone would
not protect the owner's real install on a self-hosted runner.

Branch previews use `ci-fast` (release optimization, no LTO, 16 codegen units).
Windows tags use `release` with action-scoped thin LTO and one codegen unit. If the PC is offline, select the
release tag in Actions → Butler Release → Run workflow, set `runner` to `hosted`.
The hosted fallback builds the same release profile and native dependency recipe.
Do not dispatch on a branch: this workflow publishes release assets.
