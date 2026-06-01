# release

`packages/butler-agent/src/operations/release/` contains the service-owned
release packaging contract. It validates only Butler service metadata, CLI
entrypoint, managed runtime pin, service package files, and private data safety
before a service release is considered shippable.

## Key Files

- `manifest.ts`: service release manifest creation and validation, including
  the prebuilt CLI launcher platforms included in service artifacts.
- `package-service-release.ts`: service artifact packager; it builds the native
  `butler` launchers into `packages/butler-agent/resources/cli/<platform>/` and
  the app web client into `packages/butler-agent/resources/app-client/dist/`.
- `release-gate.ts`: service-owned release gate entrypoint.

## Boundaries

Service artifacts may include the built app web client assets that the app
gateway serves at runtime. They must not include the Electron shell, app source
tree, app package metadata, or app release component ownership. Service release
checks complement but do not replace full validation, managed runtime checks,
app release gates, and native purge gates.

## Tag Release Contract

Version tags matching `v*` are the automated user-install release trigger. The
tag workflow must run the service release gate, package the service release into
`dist/release/service`, verify the tarball contains
`packages/butler-agent/resources/app-client/dist/index.html` and bundled asset
files, then publish the tarball, SHA256 file, service release manifest, and
update manifest to the GitHub Release for the same tag.

When `.github/releases/<tag>.md` exists, the tag workflow must use that file as
the GitHub Release body. Existing releases must be edited with the same notes
before assets are uploaded so release pages and artifacts stay in sync.

The tag workflow owns building the Butler App web client for user installs.
`install.sh` consumes the extracted service artifact and must not build frontend
assets during normal user installs.

## Related Specs

- `SPEC-RELEASE-PACKAGING` - Release Packaging
- `SPEC-BUTLER-CLI` - Butler CLI
- `SPEC-MANAGED-BUN-RUNTIME` - Butler-Managed Bun Runtime
