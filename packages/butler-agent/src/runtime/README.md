# Runtime storage contract

Program resources are read-only. `BUTLER_HOME` locates the current TypeScript
entrypoints and bundled resources; it is never an implicit workspace or storage
root. A future compiled runtime must not need a source checkout for writable state.

`BUTLER_DATA` (default `~/.butler`) owns general-session work, generated artifacts,
model caches, runtime state and runtime-created app bundles. An explicitly bound
project/worktree remains that project's workspace. Butler/Steward/Worker inherit
the same resolved workspace; a missing workspace never falls back to `cwd` or the
program directory. Existing unprojected bindings to the program directory are
corrected when the runtime opens them, without changing conversation identity.

Native file mutations and model-authored commands must not write into program
resources. General-session artifacts under `BUTLER_DATA/artifacts/generated` must
remain writable and publishable. On macOS, model command descendants additionally
run with an OS read-only rule for the program directory. Other platforms retain
data-owned command working directories and native file protection; equivalent
arbitrary-shell OS protection is not implemented or claimed there. Do not parse
shell text or add model instructions to guess filesystem side effects.

Developer-directed source edits, dependency installation and distributable builds
are development operations, not agent runtime storage. Runtime launch must not
create a bundle/cache in the source tree. Existing user files are preserved during
migration; do not rewrite historical transcripts or delete unrelated directories.

## Current implementation plan

1. Resolve data-owned workspaces at session admission, fallback policy and tools;
   retain explicit project/worktree bindings. Cover a real file-write entrypoint.
2. Redirect service/maintenance working directories, model caches and Electron
   runtime bundles to data. Keep resource reads at the program location.
3. Review remaining write sites, correct legacy bindings, preserve displaced files,
   and run focused path/command/service tests plus TypeScript checks.

The observed defects are source-root general sessions, rejected data artifacts,
source-local model cache and source-local development runtime bundles. No new
BTCC phase, model round, proof gate, retry protocol or UI behavior is introduced.

## Audit outcome

- General App admission, native bootstrap, child inheritance and tool defaults
  resolve to data. Explicit project/worktree bindings stay unchanged.
- Service/CLI/maintenance children execute with a data working directory; their
  script arguments remain absolute program-resource paths.
- Setup configuration and memory, model/tool/Vite caches, temporary command
  output, isolated development state and runtime-created Electron bundles use data.
- Old `BUTLER_HOME/artifacts/...` references resolve only to the preserved
  `BUTLER_DATA/artifacts/...` files. Historical messages are not rewritten.
- Private OS socket locations and standard OS-managed Electron profiles remain
  outside source. They are not source-directory storage. Explicit build/install
  commands retain their developer-owned destinations.

Focused checks cover general ingress → real file write → artifact publication,
legacy binding preservation, macOS command write protection, service command
composition and isolated development startup. No provider reasoning is needed
to validate this filesystem correction.
