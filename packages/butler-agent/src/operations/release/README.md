# release

`packages/butler-agent/src/operations/release/` contains the Butler Agent
release packaging contract. It validates only Agent metadata, CLI entrypoint,
managed runtime pin, package files, and private data safety before an Agent
release is considered shippable.

## Key Files

- `manifest.ts`: Agent release manifest creation and validation, including
  the prebuilt CLI launcher platforms included in Agent artifacts.
- `package-service-release.ts`: Agent artifact packager; it builds the native
  `butler` launchers into `packages/butler-agent/resources/cli/<platform>/` and
  the app web client into `packages/butler-agent/resources/app-client/dist/`.
- `release-gate.ts`: Agent release gate entrypoint.

## Boundaries

Agent artifacts may include the built app web client assets that the app
gateway serves at runtime. They must not include the Electron shell, app source
tree, app package metadata, or app release component ownership. Agent release
checks complement but do not replace full validation, managed runtime checks,
app release gates, and native purge gates.

## Tag Release Contract

Version tags matching `v*` are the automated public release trigger. The GitHub
Release groups assets into Recommended Butler App downloads and Advanced Butler
Agent downloads.

For the Agent group, the tag workflow must run the Agent release gate, package
the Agent release into the `dist/release/agent` directory, verify the tarball
contains `packages/butler-agent/resources/app-client/dist/index.html` and
bundled asset files, then publish the `butler-agent-*-all.tar.gz` tarball,
SHA256 file, `agent-release-manifest.json`, and `agent-update-manifest.json` to
the GitHub Release for the same tag.

When `.github/releases/<tag>.md` exists, the tag workflow must use that file as
the GitHub Release body. Existing releases must be edited with the same notes
before assets are uploaded so release pages and artifacts stay in sync.

The App group is the default user install path. The App artifact includes the
Agent payload; App users do not run `install.sh` to prepare the bundled Agent.

The Agent workflow owns building the Butler App web client only for standalone
Agent installs. `install.sh` consumes the extracted Agent artifact and must not
build frontend assets during normal standalone Agent installs.

## Related Specs

- `SPEC-RELEASE-PACKAGING` - Release Packaging
- `SPEC-BUTLER-CLI` - Butler CLI
- `SPEC-MANAGED-BUN-RUNTIME` - Butler-Managed Bun Runtime
