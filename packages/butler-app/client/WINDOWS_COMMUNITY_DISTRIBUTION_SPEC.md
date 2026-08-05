# Windows Community Distribution And Update Spec

## Accepted intent and priority

Microsoft Store is Butler's primary Windows distribution path. GitHub Releases
must distribute the Windows x64 installer in parallel during Store onboarding
and for a user-controlled transition period afterward. SignPath Foundation is
an optional later improvement for the GitHub path, not a co-equal primary
channel. Until public-trust signing is available, the GitHub installer may show
an unknown-publisher or SmartScreen warning, but users whose Windows policy
permits override must be able to choose More info and Run anyway.

GitHub-installed Butler must retain Butler's existing in-app Electron update
experience. Users check and apply the latest release from Butler Settings; they
must not have to uninstall or manually download every subsequent version.

## Authority and ownership

- The existing Squirrel Windows packager owns installer and updater construction.
- A stable, long-lived self-signed community certificate owns GitHub-channel
  update continuity. Its private PFX and password live only in GitHub Actions
  secrets; its signature is not represented as public trust and does not remove
  first-install warnings.
- Hosted Windows CI owns certificate import, PE signing, runtime validation,
  checksum generation, and the full Windows release package gate.
- A manually dispatched community-distribution workflow owns publishing the
  exact tagged build to an existing GitHub release.
- The existing production Windows distribution workflow remains the authority
  for future SignPath/public-trust assets and keeps its certificate requirements.
- For a packaged Squirrel installation, Electron injects the GitHub Windows
  manifest source into its App-owned Gateway. The update store owns discovery
  through `windows-app-update-manifest.json`; the existing renderer Settings
  surface owns user action; Electron owns staged-installer publisher verification,
  foreground work drain, quit, and Squirrel activation.
- Microsoft Store packages and updates remain Store-owned. The GitHub updater
  must not take ownership of a Store-managed install.

## Community release state machine

1. `waiting`: no community publication occurs automatically.
2. `requested`: a maintainer dispatches with an existing semantic release tag
   and the exact non-public-trust acknowledgement.
3. `validated`: the release exists, checkout equals the tag commit, and stable
   community PFX/password inputs are present and parse to a code-signing cert.
4. `built`: the existing Windows package path signs the packaged PE inventory
   and Setup with that stable community certificate.
5. `verified`: the existing Windows release smoke proves x64 PE shape, bundled
   runtime/process-host integrity, one consistent signer, Squirrel package/index,
   manifests, and checksums.
6. `published`: the complete eight-file Windows set is uploaded: Setup and
   SHA-256, `.nupkg` and SHA-256, `RELEASES` and SHA-256, and Windows release and
   update manifests. A rerun replaces only these deterministic assets.
7. `failed`: invalid input, missing secrets/release, build failure, incomplete
   output, signer mismatch, or checksum failure stops before upload.

## Installed update state machine

1. `idle`: the installed version continues running with no polling loop.
2. `checking`: the user opens or refreshes Settings updates; Windows resolves
   the GitHub latest `windows-app-update-manifest.json`.
3. `available`: a newer compatible `win32-x64` artifact is displayed.
4. `staging`: the existing updater downloads the Setup artifact into Butler data
   and verifies the manifest SHA-256 before returning a staged path.
5. `publisher-check`: Electron inspects current and candidate Authenticode data.
   Public-trust releases retain the existing valid-chain/same-publisher rule.
   Community releases may have an untrusted chain, but both files must have an
   intact Authenticode signature, the exact same certificate thumbprint and
   subject, and neither status may be NotSigned, HashMismatch, NotSupported, or
   Incompatible.
6. `draining`: Electron uses the existing active-work confirmation and shutdown
   path. Cancellation keeps the current app running and leaves the staged file
   recoverable for retry.
7. `installing`: Electron launches the staged Squirrel Setup and quits only after
   foreground work has drained.
8. `completed`: Squirrel activates the new version; its existing lifecycle hook
   recreates the shortcut and the next launch reconciles the bundled Agent.
9. `failed`: digest, publisher, process launch, or Squirrel failure is surfaced as
   an update failure and must not replace the current version.

## Artifact and UX contract

- Community and future public-trust GitHub releases use the canonical filename
  `butler-app-<version>-win32-x64-setup.exe`; signing can improve later without
  changing download or updater URLs.
- GitHub Releases publish the Windows Squirrel feed and platform-specific
  manifests required by in-app updates.
- A packaged Squirrel App injects
  `https://github.com/Hexpy-Games/butler/releases/latest/download/windows-app-update-manifest.json`
  into its App-owned Gateway. Browser, macOS, Linux, development, explicit test
  environments, and future Store-owned Windows installs keep their existing or
  explicitly configured manifest source.
- Squirrel ownership is recognized from the packaged Windows executable's
  versioned `butler-app/app-<version>/Butler.exe` layout and version-independent
  Squirrel root. Merely running on Windows or setting `app.isPackaged` is not
  sufficient to opt a Store or unrelated build into the GitHub channel.
- README presents Microsoft Store as primary and GitHub Releases as parallel,
  explains More info -> Run anyway, and distinguishes Smart App Control blocking.
- Settings update copy and DS components remain unchanged unless executable
  validation proves new user feedback is required.

## Security, key continuity, and recovery

- The stable self-signed key costs nothing but is a sensitive release secret. It
  must never be committed, printed, uploaded as an artifact, or copied into the
  app. Only its public certificate is embedded in Authenticode signatures.
- The first GitHub installer is the trust-on-first-install boundary. GitHub HTTPS
  delivery plus the published SHA-256 sidecar protects that handoff; subsequent
  updates additionally pin the installed certificate thumbprint.
- A community key rotation cannot silently replace the pin. It requires a bridge
  release signed by the old key or an explicit user-approved reinstall.
- Store installs do not consume GitHub community feeds. Channel detection must
  fail closed if Store ownership cannot be distinguished safely.
- No timer or polling loop is added. Existing user-initiated Settings checks are
  sufficient for this phase.

## Non-goals and forbidden substitutions

- Do not disable SmartScreen or Smart App Control, remove Mark-of-the-Web, or
  claim warning-free first installation.
- Do not make community publication automatic on tags or pull requests.
- Do not accept unsigned or hash-mismatched update executables.
- Do not accept a different self-signed certificate merely because its subject
  string matches.
- Do not weaken production public-trust signing or replace the existing Settings
  update flow with a second UI.
- Do not publish an arbitrary branch/commit or expose the community private key.
- Do not remove GitHub Releases merely because the Store listing becomes live.

## Acceptance and validation

1. Tests prove the community workflow is manual, exact-tag based, explicitly
   acknowledged, requires the stable community secrets, reuses the production
   package verifier, and uploads exactly the expected eight files.
2. Tests prove production distribution keeps its independent certificate gate.
3. Tests exercise real Windows manifest-source selection without changing other
   platform defaults.
4. Publisher tests cover public-trust success, community same-thumbprint success,
   different-thumbprint rejection, unsigned/hash-mismatch rejection, malformed
   PowerShell output, and sanitized child environment.
5. Existing update staging, foreground drain/cancel, Squirrel lifecycle, README,
   targeted tests, `bun run check`, and `git diff --check` pass.
6. Windows CI builds the exact reviewed commit. Luna Max performs a physical
   install plus Settings-driven staged update across two package versions, and
   verifies launch/version transition and uninstall.
7. Sol High reviews the full tag -> GitHub assets -> Settings check -> verified
   staged installer -> drain -> Squirrel activation path with no findings.
