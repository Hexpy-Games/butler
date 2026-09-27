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
- UI quality: `lint/`.
- Codemods: `codemods/ds-unsafe-style.ts` (ts-morph) moves geometry-only `style` on
  design-system components to `UNSAFE_style` and fails while any `className`/`style`
  remains on one.

## macOS Release Signing And Notarization

`release/package-app-release.ts` produces the public DMG and the updater ZIP.
With Developer ID credentials it signs, notarizes and staples them; without
credentials it builds the same artifacts ad-hoc signed for local and fork use.
Ad-hoc artifacts are never public release evidence.

### What the pipeline does

1. **Inside-out signing** (`release/mac-signing.ts`, no `codesign --deep`).
   Every nested Mach-O and bundle is signed deepest first, then the App:
   - the bundled native Agent (`Contents/Resources/bundled-agent/bin/butler-agent`,
     identifier `com.hexpy.butler.agent`) and any other executable or dylib,
     including Electron's `Libraries/*.dylib`, `chrome_crashpad_handler` and
     Squirrel's `ShipIt`;
   - the frameworks (`Electron Framework`, `Mantle`, `ReactiveObjC`, `Squirrel`);
   - the Electron helper apps and the `Butler Menu Bar Helper` login item;
   - `Butler.app`.

   Production signing adds `--options runtime` (hardened runtime) and
   `--timestamp`. Afterwards `codesign --verify --deep --strict` must pass and
   every nested signature must be Developer ID, from the release team,
   hardened and timestamped, or packaging stops before notarization.
2. **Notarization**: the signed App is zipped, submitted with
   `xcrun notarytool submit --wait`, required to be `Accepted` (the notary log
   is printed otherwise) and stapled. The DMG and updater ZIP are then built
   from the stapled App.
3. **DMG**: `Butler.app`, an `Applications` link and a branded background, laid
   out by a `.DS_Store` that `release/mac-dmg.ts` writes directly (no Finder
   scripting, so it works headless). The DMG is then signed, notarized and
   stapled.
4. **Smoke** (`deploy/app/smoke.ts`, `BUTLER_APP_RELEASE_SMOKE_MODE=production`):
   mounts the DMG and unpacks the ZIP, then checks `codesign --verify --deep
   --strict`, the per-component Developer ID signatures, `stapler validate`,
   and `spctl --assess` (Gatekeeper must report `Notarized Developer ID`).

### Entitlements

Only the Electron main app and the Electron helper apps
(`Butler Helper`, `(GPU)`, `(Renderer)`, `(Plugin)`) get
`release/macos/electron.entitlements.plist`:

| Entitlement | Why |
| --- | --- |
| `com.apple.security.cs.allow-jit` | V8 (Node in the main process, JavaScript and WebAssembly in renderers) and SwiftShader in the GPU helper generate code at runtime with `MAP_JIT`. Without it the hardened runtime kills those processes. |

Deliberately not granted:

- `com.apple.security.cs.allow-unsigned-executable-memory`: current Electron
  uses `MAP_JIT`, so `allow-jit` is enough.
- `com.apple.security.cs.disable-library-validation`: every dylib and framework
  in the bundle is re-signed with the Butler team ID and Butler loads no
  third-party native modules, so library validation passes.
- Anything for the native Agent, the menu bar helper, crashpad or ShipIt: they
  do not JIT, load foreign libraries or need device access, so they run under
  the hardened runtime with no exceptions.
- `com.apple.security.automation.apple-events`: nothing in Butler sends Apple
  Events today. Add it (plus `NSAppleEventsUsageDescription`) only if Butler
  or its tools must script other apps.

### GitHub secrets

The release workflow signs only when all six secrets exist. With none it
builds ad-hoc; with some but not all it fails.

| Secret | Contents |
| --- | --- |
| `MACOS_DEVELOPER_ID_P12_BASE64` | Base64 of the Developer ID Application certificate and private key (`.p12`). |
| `MACOS_DEVELOPER_ID_P12_PASSWORD` | The password chosen when exporting that `.p12`. |
| `APPLE_API_KEY_P8_BASE64` | Base64 of the App Store Connect API key file (`AuthKey_<KEY_ID>.p8`). |
| `APPLE_API_KEY_ID` | That key's Key ID (10 characters). |
| `APPLE_API_ISSUER_ID` | The Issuer ID (UUID) shown on the App Store Connect API keys page. |
| `APPLE_TEAM_ID` | The Hexpy Games Team ID (10 characters, Membership details). The workflow picks the Developer ID identity for this team and rejects signatures from any other team. |

**Developer ID Application certificate.** Only the Account Holder of the Hexpy
Games Apple Developer account can create it.

1. On a Mac, open Keychain Access and choose **Keychain Access > Certificate
   Assistant > Request a Certificate From a Certificate Authority**. Enter the
   Account Holder's email and `Hexpy Games` as the common name, choose
   **Saved to disk**, and save the `.certSigningRequest`. The private key stays
   in that Mac's login keychain.
2. At [developer.apple.com](https://developer.apple.com/account/resources/certificates/add),
   add a certificate, choose **Developer ID Application** (G2 Sub-CA), upload
   the CSR and download the `.cer`.
3. Double-click the `.cer` so it pairs with the private key. In Keychain Access
   > **My Certificates**, select `Developer ID Application: Hexpy Games (TEAMID)`
   with its key, **Export** it as a `.p12` and set a strong password.
4. Store it:

   ```bash
   base64 -i developer-id-application.p12 | gh secret set MACOS_DEVELOPER_ID_P12_BASE64
   gh secret set MACOS_DEVELOPER_ID_P12_PASSWORD   # paste the export password
   ```

   Delete the local `.p12` afterwards; keep the certificate backed up in the
   Account Holder's keychain.

**App Store Connect API key.** In App Store Connect, open **Users and Access >
Integrations > App Store Connect API > Team Keys** (the Account Holder may need
to request API access first). Generate a key with the **Developer** role and
download `AuthKey_<KEY_ID>.p8`; Apple allows a single download. Then:

```bash
base64 -i AuthKey_ABC123DEFG.p8 | gh secret set APPLE_API_KEY_P8_BASE64
gh secret set APPLE_API_KEY_ID --body ABC123DEFG
gh secret set APPLE_API_ISSUER_ID --body 00000000-0000-0000-0000-000000000000
gh secret set APPLE_TEAM_ID --body TEAMID1234
```

In CI the workflow imports the `.p12` (plus Apple's Developer ID G2
intermediate) into a temporary keychain with a random password, picks the
identity for `APPLE_TEAM_ID`, stores the API key as a
`notarytool` profile in that keychain, deletes the decoded key files at once,
and deletes the keychain in a final `always()` step.

### Local production-signed build

1. Import the `.p12` into your login keychain and confirm the identity:
   `security find-identity -v -p codesigning`.
2. Store notary credentials once (kept in the login keychain):

   ```bash
   xcrun notarytool store-credentials butler-notary \
     --key ~/secure/AuthKey_ABC123DEFG.p8 --key-id ABC123DEFG \
     --issuer 00000000-0000-0000-0000-000000000000
   ```

3. Build the renderer and Electron dependencies, then package and smoke:

   ```bash
   npm --prefix packages/butler-app/client/electron ci
   bun run app:ui:build
   export BUTLER_APP_SIGN_IDENTITY="Developer ID Application: Hexpy Games (TEAMID1234)"
   export BUTLER_APP_NOTARY_KEYCHAIN_PROFILE=butler-notary
   export BUTLER_APP_TEAM_ID=TEAMID1234
   export BUTLER_APP_REQUIRE_PRODUCTION_SIGNING=1
   bun run release:app:package -- --platform=darwin-arm64 --out dist/release/app
   BUTLER_APP_RELEASE_SMOKE_MODE=production \
     bun run release:app:smoke -- --platform=darwin-arm64 --out dist/release/app
   ```

Leave `BUTLER_APP_SIGN_IDENTITY` unset for an ad-hoc build. Packaging compiles
the native Agent, so the Rust toolchain from `packages/butler-agent/rust` is
also required.

| Variable | Meaning |
| --- | --- |
| `BUTLER_APP_SIGN_IDENTITY` | Developer ID Application identity (name or SHA-1). Unset means ad-hoc. |
| `BUTLER_APP_SIGN_KEYCHAIN` | Optional keychain that holds the identity (CI uses its temporary keychain). |
| `BUTLER_APP_NOTARY_KEYCHAIN_PROFILE` | `notarytool` keychain profile. Unset skips notarization. |
| `BUTLER_APP_NOTARY_KEYCHAIN` | Optional keychain that holds the profile. |
| `BUTLER_APP_TEAM_ID` | Expected team ID for signature checks. |
| `BUTLER_APP_REQUIRE_PRODUCTION_SIGNING` | `1` fails the build when the identity or profile is missing. |
| `BUTLER_APP_RELEASE_SMOKE_MODE` | `ad-hoc` or `production` for `release:app:smoke`. |

The DMG background is `release/macos/dmg-background.tiff` (1x + 2x), rendered
by `release/macos/render-dmg-background.swift`; see the command at the top of
that file. Its geometry must match `DMG_LAYOUT` in `release/mac-dmg.ts`.

## Boundaries

These scripts validate the Butler App product. Agent runtime validation stays
under `packages/butler-agent/`; repo-wide `tools/` should only hold
package-neutral orchestration.

## Related Specs

- `SPEC-BUTLER-DEDICATED-CLIENT` - Butler Dedicated Client
- `SPEC-BUTLER-DEDICATED-CLIENT-APP-EXPERIENCE` - Butler Dedicated Client App Experience
- `SPEC-BUTLER-DEDICATED-CLIENT-DESIGN-SYSTEM` - Butler Dedicated Client Design System
- `SPEC-RELEASE-PACKAGING` - Release Packaging
