Windows jobs build on `yw-pc` with labels `[self-hosted, butler-win]`.
Only same-repository PRs can reach it. Installer, protocol, lifecycle and LAN
verification runs on disposable `windows-latest` with compiled artifacts.
No self-hosted job may register protocols, services, login items, shortcuts,
credentials or firewall rules. A temporary profile does not isolate the registry.

Caches persist under `C:\actions-cache`: each workflow owns its Cargo target,
Bun uses `bun`, and static ORT uses `ort`. The pinned preparation script verifies
archive and output hashes before adopting an existing ORT tree. Cleanup removes
only the job's temporary profile and checks the owner's protocol key unchanged.

Branch previews use `ci-fast` (release optimization, no LTO, 16 codegen units).
Windows tags use `release` with action-scoped thin LTO and one codegen unit. If the PC is offline, select the
release tag in Actions → Butler Release → Run workflow, set `runner` to `hosted`.
The hosted fallback builds the same release profile and native dependency recipe.
Do not dispatch on a branch: this workflow publishes release assets.
