# Windows Community Distribution Spec

## Accepted intent and priority

Microsoft Store is Butler's primary Windows distribution path. Because Store
onboarding and review take time, GitHub Releases must distribute the Windows x64
installer in parallel during the transition and may remain available alongside
the Store listing. SignPath Foundation is an optional later improvement for the
GitHub path, not a co-equal primary channel. Until public-trust signing is
available, maintainers must be able to publish the existing installer from a
tagged Butler release without a paid certificate. Windows may show an
unknown-publisher or SmartScreen warning; a user on a machine that permits
SmartScreen override must be able to choose More info and Run anyway, then
complete the normal installer.

## Authority and ownership

- The existing Squirrel Windows packager owns installer construction.
- Hosted Windows CI owns the ephemeral self-signed build certificate, PE and
  runtime validation, checksum generation, and package artifact retention.
- A separate manually dispatched community-distribution workflow owns publishing
  the installer and its SHA-256 sidecar to an existing GitHub release.
- The existing production Windows distribution workflow remains the authority
  for public-trust signed release assets and must keep requiring its certificate
  inputs.
- GitHub Release copy and the repository README own the user-facing warning and
  installation instructions, including that GitHub Releases and Microsoft Store
  are parallel distribution channels during the transition.

## Community release state machine

1. `waiting`: no community distribution occurs automatically.
2. `requested`: a maintainer dispatches the workflow with an existing semantic
   release tag and an explicit acknowledgement value.
3. `validated`: the workflow confirms the tag and release exist and the
   acknowledgement exactly authorizes non-public-trust distribution.
4. `built`: the workflow checks out the exact tag and invokes the existing
   Windows package build with its ephemeral CI certificate.
5. `verified`: existing Windows package validation proves PE architecture,
   bundled runtime/process host integrity, Squirrel structure, and checksums.
6. `published`: only the community Setup executable and matching SHA-256 sidecar
   are uploaded to the existing release. Squirrel updater feeds and internal
   manifests are not published from this path.
7. `failed`: invalid input, missing release, build failure, incomplete output, or
   checksum mismatch stops before upload. A rerun is idempotent and replaces only
   the two community assets.

## Artifact and UX contract

- The public filenames are
  `butler-app-<version>-win32-x64-community-setup.exe` and its `.sha256` sidecar.
- The community asset is not represented as a trusted-publisher build. It uses
  an ephemeral CI self-signature solely so the existing Windows package/runtime
  integrity checks exercise the same packaged PE inventory.
- README instructions state `More info -> Run anyway` for ordinary SmartScreen
  warning flows.
- README also states that Smart App Control enforcement can block the app without
  an override and that the supported options in that case are Store/SignPath or
  using a machine whose policy permits the app.
- Installation, first-run, application runtime, and uninstall semantics remain
  identical to the existing Windows Squirrel package.

## Security and recovery

- SHA-256 is regenerated after the community filename is applied and verified
  immediately before upload.
- The workflow receives no certificate secret and never imports a maintainer key.
- The workflow requires an exact acknowledgement so it cannot be confused with
  production public-trust distribution.
- A failed or canceled run does not mutate a GitHub release before all local
  validations complete.
- Re-running the same tag uses `--clobber` only for the two deterministic
  community filenames.

## Non-goals and forbidden substitutions

- Do not disable Windows security controls, automate Smart App Control changes,
  remove Mark-of-the-Web, or claim warning-free installation.
- Do not make the community workflow automatic on tags or pull requests.
- Do not relax production signing requirements or publish updater feed files
  signed by an ephemeral certificate.
- Do not introduce a second installer implementation or change application UI.
- Do not publish from an arbitrary branch or untagged commit.
- Do not remove or hide the GitHub Releases path when the Store listing becomes
  available; changing the parallel-channel policy requires a new user decision.

## Acceptance and validation

1. Unit tests prove the community workflow is manual, exact-tag based, requires
   acknowledgement, uses the existing package gate, publishes exactly two
   deterministic assets, and has no signing secrets.
2. Unit tests prove production distribution still requires its certificate.
3. README tests cover the community artifact and both SmartScreen and Smart App
   Control copy.
4. Targeted tests, `bun run check`, and `git diff --check` pass.
5. Windows CI builds the exact reviewed commit and Luna Max performs a real
   download/install/launch/uninstall exercise on the physical Windows machine.
6. Sol High reviews the complete tag-to-GitHub-Release and
   download-to-installed-App paths with no remaining findings.
