# Standalone macOS arm64 archive

`prepare-native-agent.mjs` prepares the macOS arm64 payload. It invokes the
pinned static ONNX Runtime preparer and pinned Rust release build. The result
uses `butler.native-agent-payload.v1` and contains the native binary at
`bin/butler-agent` with its adjacent `resources` tree. The release gate,
packager, and archive smoke operate on that prepared payload; those steps do
not invoke Cargo or download build dependencies.

```sh
node packages/butler-app/client/electron/scripts/prepare-native-agent.mjs \
  darwin arm64 "$BUTLER_NATIVE_AGENT_PAYLOAD"
python3 packages/butler-agent/rust/scripts/release-standalone-macos-arm64.py \
  gate --payload "$BUTLER_NATIVE_AGENT_PAYLOAD"
```

The root release scripts default `BUTLER_NATIVE_AGENT_PAYLOAD` to
`packages/butler-app/client/electron/.native-agent-payload/bundled-agent` and
`BUTLER_AGENT_ARCHIVE` to
`dist/release/agent/butler-agent-darwin-arm64.tar.gz`. Override either
environment variable to use a different prepared payload or archive path.
`release:agent:package` (also `release:service:package`) invokes the native
Python packager directly; pass `--artifact-url` after `--` when publishing.
`release:agent:smoke` validates the resulting archive and its adjacent release
manifests. When a published URL is provided to the packager, pass the same
`--artifact-url` to smoke so it can verify both manifests record that exact
archive URL.

```sh
python3 packages/butler-agent/rust/scripts/package-standalone-macos-arm64.py \
  --payload "$BUTLER_NATIVE_AGENT_PAYLOAD" \
  --output "$BUTLER_AGENT_ARCHIVE" \
  --artifact-url https://github.com/owner/repository/releases/download/v0.0.21/butler-agent-0.0.21-darwin-arm64.tar.gz
python3 packages/butler-agent/rust/scripts/release-standalone-macos-arm64.py \
  smoke --archive "$BUTLER_AGENT_ARCHIVE" \
  --artifact-url https://github.com/owner/repository/releases/download/v0.0.21/butler-agent-0.0.21-darwin-arm64.tar.gz
```

The archive root contains the executable `butler-agent`, a `butler` symlink to
that executable, `resources/`, and `native-agent-manifest.json`. The manifest
uses `butler.native-agent-install.v1`; its version and SHA-256 digests describe
the packaged payload. The archive contains no Node or Bun launcher. The
installer is responsible for extracting it into an install directory; Agent
updates only stage verified archives under DATA for that user-controlled step.
The packager also writes adjacent `agent-release-manifest.json` and
`agent-update-manifest.json` files with the archive SHA-256 and a separate
macOS arm64 service artifact. Without `--artifact-url`, the manifests retain a
null URL and cannot be used to stage a remote update. Activation is a user
installation step; Butler does not replace the running package or claim
managed rollback.

Linux standalone native releases have not been validated and are not a current
release target.

The release smoke rejects unsafe or duplicate tar entries, checks the archive
and both manifest digests and identities, then installs into a temporary
directory and invokes `butler version --json` and
`butler doctor --check installation --json`. It requires native installation
provenance and all four installation checks to pass, and confirms the installed
tree and archive were not changed by those commands.

The tag workflow runs on `macos-15` arm64 with Python 3.12 and Rust 1.91.0. It
gates, packages, and smokes the standalone Agent archive, then runs the App's
`darwin-arm64` native packaging branch and publishes its DMG, ZIP, sidecar
checksums, and manifests. The App packager currently prepares a fresh payload
directory, so the workflow reuses the native Rust build output but does not
pass the standalone archive's payload directory directly into the App
packager. Linux Bun and Arch release jobs are not part of this workflow.
