# Butler App Scripts

`packages/butler-app/scripts/` contains app-owned development, HMR, release,
and client-only quality checks. `bun run dev:butler` is the one-command local
development path: it starts the existing Agent-owned app gateway, waits for
its `/health` endpoint, and then starts the existing `app:client:dev` Vite and
Electron path.

The command uses `BUTLER_DATA/development/<checkout-id>` by default (with
`~/.butler` as the default `BUTLER_DATA`), separate development ports (`28765`
for the gateway and `25173` for Vite), and `app/electron-user-data` beneath that
isolated data root for the Electron profile. It
prints the selected data root and URLs before startup and keeps the data root
when the run stops. Deliberate overrides are supported through
`BUTLER_DEV_DATA`, `BUTLER_DEV_SERVER_PORT`, and `BUTLER_DEV_UI_PORT`. The
runner uses the normal data root only as the parent of the isolated development
directory; relative `BUTLER_DEV_DATA` overrides resolve there, not in source.
It maps the development configuration into the child processes without using
normal runtime ports. Gateway/UI hosts remain loopback-only, and the Electron profile
always stays under the selected development data root.

The runner owns the gateway and client children it starts. Ctrl-C, termination,
readiness failure, or either child exiting settles the other child; it does not
delete development data. It uses direct Node/Bun child-process APIs, with POSIX
process groups and attached Windows children, and does not start a second
gateway or Electron runtime.

## Key Areas

- Client development: `app-client-dev.ts`.
- Manual first-run testing: `app-first-run-test-env.ts` launches Electron with
  a clean Butler data root, isolated Electron profile, and local managed
  app-server port so the App setup path can be inspected without touching the
  user's real `~/.butler` state. This is a clean-launch inspection harness; it
  does not prove the first-run setup wizard is implemented.
- App smoke and E2E: `app-client-managed-server-smoke.ts` and
  `app-ui-hmr-smoke.ts` stay here when they are client-owned. Package, layout,
  design-system, render, model-management, and multi-turn checks live under
  `tests/` because they start or inspect the agent-owned app gateway.
- App release: `release/manifest.ts`, `release/release-gate.ts`, and
  `release/package-app-release.ts` validate and package app artifacts without
  depending on service release internals.
- Linux App packages: `release/package-linux-app.ts` builds the DEB (x64,
  arm64) and Arch (x64) packages with the bundled native agent on a Linux host
  of the target architecture; `release/linux-package-smoke.sh` installs one in
  a clean container and runs its agent headless. CI:
  `.github/workflows/linux-packages.yml` (PRs, main, nightly and manual runs;
  called by `release.yml` for tags before packages are attached to the draft).
- UI quality: `lint/`.
- Codemods: `codemods/ds-unsafe-style.ts` (ts-morph) moves geometry-only `style` on
  design-system components to `UNSAFE_style` and fails while any `className`/`style`
  remains on one.

## macOS Release Signing And Notarization

`.github/workflows/release.yml` (`v*` tags) signs and notarizes the macOS
artifacts with the configured Developer ID for stable tags. All logic lives in
`deploy/macos/sign-and-notarize.sh`; PR CI and local builds stay ad-hoc signed
because every command is a logged no-op without `BUTLER_SIGN_IDENTITY`.

The `native-release` job declares `environment: deploy`, which is restricted to
`v*` tags and holds these secrets (never available to PRs):

| Secret | Contents |
| --- | --- |
| `APPLE_DEVELOPER_ID_P12_BASE64` | Base64 of the Developer ID Application `.p12` |
| `APPLE_DEVELOPER_ID_P12_PASSWORD` | Password of that `.p12` |
| `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID` | App Store Connect API key for `notarytool` |
| `APPLE_API_KEY_P8` | The `AuthKey_<id>.p8` contents (PEM, or base64 of it) |
| `APPLE_TEAM_ID` | Team ID; selects the identity and is enforced on every signature |

Release flow: `setup` (just before the Agent step, after the dependency installs) creates a temporary keychain and imports the identity, the
`agent` step signs and notarizes `butler-agent` before the tar.gz, manifests and
SHA-256 are computed, `sign-app` signs the App inside-out (loose Mach-O, then
frameworks/helpers deepest first, then `Butler.app`, no `--deep`) with the
hardened runtime and a secure timestamp, the App is notarized and stapled, then
the DMG is signed, notarized and stapled; `cleanup` (`if: always()`) deletes the
keychain and key. The GitHub Release is created as a draft and published only
after the App passes its signing policy and smoke checks. A bare CLI binary cannot be stapled, so
the Agent is gated on `codesign --check-notarization` (online ticket). Missing or partial secrets fail the release.

Owner decision (2026-10-01): tags matching `vX.Y.Z-preview.*` are unofficial
previews. Certificate setup runs independently of the notary credentials. If it
fails, setup removes partial credentials and selects `codesign -s -`. Previews
never validate or use the notary API key, submit to notarization, staple, or
require Gatekeeper's notarized verdict. Signature validity, payload closure,
smoke tests, SHA-256 sidecars and all 18 consolidated checksum entries remain
required. Stable tags retain mandatory Developer ID signing and notarization;
certificate, notary or staple failures stop publication.

The macOS App updater runs in the bundled Agent through `operations/update.rs`.
With `update.previews: false`, the default `/releases/latest/download/app-update-manifest.json`
excludes prereleases. With previews enabled, it lists GitHub releases, skips drafts,
and selects the highest SemVer tag carrying `app-update-manifest.json`, then selects
the matching App platform/package from that manifest. Status reads retain the six-hour
saved-result cache; explicit refresh fetches the release list again. There is no ETag cache.
`BUTLER_UPDATE_RELEASES_API` can point default discovery at a compatible release API
(for isolated smoke fixtures); stable discovery uses its `/latest` endpoint. Explicit
`BUTLER_APP_UPDATE_MANIFEST` URLs still bypass release discovery.

Preview.6 and .7 cached the selected release URL for six hours even on refresh. An
already running old App can keep offering the old tag until that cache expires.
Quitting and reopening the App clears this process cache; no DATA/cache deletion or
mandatory manual upgrade is needed. New previews must remain published, non-draft
GitHub releases with the exact `app-update-manifest.json` asset name, full SemVer
artifact versions, channel `preview`, platform `darwin-arm64`, and a SHA-256-pinned
App ZIP. Existing release packaging/publication already emits this form, which old
builds can discover on a cold check. Do not move preview publication to `/latest`
or relabel it as stable to work around the old cache.

App activation remains manual (`user-installs-app-package`); SHA-256 verification
and package signature checks still apply. `signing.notarized` is release metadata,
not an updater acceptance condition. macOS may require right-click → Open or
Privacy & Security → Open Anyway. The ZIP contains the same signed App as the DMG.
The Agent updater likewise checks archive integrity, not notarization. CLI installs
via curl or npx do not use the App's Gatekeeper open flow.

Entitlements (`deploy/macos/electron.entitlements.plist`) apply only to
`Butler.app` and the Electron helper apps: `allow-jit` (V8
MAP_JIT). The Agent, dylibs and the menu bar helper
get none.

Manifests record `signing: { teamId, notarized }` per artifact (`null` for
local ad-hoc builds; an empty `teamId` and `notarized: false` for ad-hoc previews). `integrity.signature` stays reserved for a detached signature.
`release:app:smoke` and `release:agent:smoke` re-check Team ID, hardened
runtime, timestamp, staple and `spctl` when signing is on.
`.github/workflows/macos-signing.yml` runs shellcheck and an ad-hoc self-test
(`deploy/macos/selftest.sh`) on PRs.

First tag: confirm the `native-release` run shows `sign: notarized ...
(Accepted)` for the Agent, the App and the DMG, then on a Mac:

```bash
codesign --verify --strict --deep --verbose=2 /Applications/Butler.app
spctl -a -vv -t exec /Applications/Butler.app
spctl -a -vv -t open --context context:primary-signature butler-app-*.dmg
xcrun stapler validate butler-app-*.dmg
```

## Boundaries

These scripts validate the Butler App product. Agent runtime validation stays
under `packages/butler-agent/`; repo-wide `tools/` should only hold
package-neutral orchestration.

## Related Specs

- `SPEC-BUTLER-DEDICATED-CLIENT` - Butler Dedicated Client
- `SPEC-BUTLER-DEDICATED-CLIENT-APP-EXPERIENCE` - Butler Dedicated Client App Experience
- `SPEC-BUTLER-DEDICATED-CLIENT-DESIGN-SYSTEM` - Butler Dedicated Client Design System
- `SPEC-RELEASE-PACKAGING` - Release Packaging

Release recovery keeps credential tools in the job-private `BUTLER_SIGN_HOME` that
created their temporary keychain; Butler package/gate/smoke commands retain fresh
HOME and data directories. The release records a paired old/current Developer ID
probe before claiming that profile binding caused a repair (#498).

If a published preview lacks its macOS App, dispatch `macos-release-recovery.yml`
from a later qualified preview tag with the target and baseline tags. It uses the
target's immutable product source and checksum-verified published Agent, changes
only the signing tool, refuses to replace an existing macOS App, preserves all
existing platform entries, regenerates checksums, and runs the real published
baseline-to-target update smoke. It cannot run from a branch or stable tag.
The npm tarball and SHA-256 are release assets; packing never publishes to npm.
