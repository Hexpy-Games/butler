# Standalone Agent archives

Agent-only archives for `darwin-arm64`, `linux-x64` and `linux-arm64`. They are
what `install.sh` and `butler install` put into the shared install layout (see
[`../docs/install-layout.md`](../docs/install-layout.md)); the desktop App
bundles the same agent separately.

`prepare-native-agent.mjs` prepares the payload for the host's own platform
(builds are native only). It invokes the pinned static ONNX Runtime preparer and
pinned Rust release build. The result uses `butler.native-agent-payload.v1` and
contains the native binary at `bin/butler-agent` with its adjacent `resources`
tree. The release gate, packager, and archive smoke operate on that prepared
payload; those steps do not invoke Cargo or download build dependencies. The
target platform comes from the payload manifest and is checked against the
binary (lipo/otool on macOS, readelf on Linux: architecture and no dynamic
dependency beyond the system or glibc runtime).

```sh
node packages/butler-app/client/electron/scripts/prepare-native-agent.mjs \
  "$(uname -s | tr A-Z a-z)" "$ARCH" "$BUTLER_NATIVE_AGENT_PAYLOAD"   # ARCH: arm64 or x64
python3 packages/butler-agent/rust/scripts/release-standalone-agent.py \
  gate --payload "$BUTLER_NATIVE_AGENT_PAYLOAD"
```

Set `BUTLER_NATIVE_AGENT_EXECUTABLE` to an existing executable `butler-agent`
to skip the static ONNX Runtime preparation and Cargo build and lay out the
payload from that binary instead (useful for App smoke runs against a shared
prebuilt agent). The producer prints the binary it used and its sha256 either
way. Leave it unset for release payloads.

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
python3 packages/butler-agent/rust/scripts/package-standalone-agent.py \
  --payload "$BUTLER_NATIVE_AGENT_PAYLOAD" \
  --output "$BUTLER_AGENT_ARCHIVE" \
  --artifact-url https://github.com/owner/repository/releases/download/v0.0.21/butler-agent-0.0.21-linux-x64.tar.gz
python3 packages/butler-agent/rust/scripts/release-standalone-agent.py \
  smoke --archive "$BUTLER_AGENT_ARCHIVE" \
  --artifact-url https://github.com/owner/repository/releases/download/v0.0.21/butler-agent-0.0.21-linux-x64.tar.gz
```

The archive root contains the executable `butler-agent`, a `butler` symlink to
that executable, `resources/`, and `native-agent-manifest.json`. The manifest
uses `butler.native-agent-install.v1`; its version and SHA-256 digests describe
the packaged payload. The archive contains no Node or Bun launcher.

The packager also writes adjacent `agent-release-manifest.json` and
`agent-update-manifest.json` files with the archive SHA-256 and one service
artifact whose `platform` is the target label. Without `--artifact-url`, the
manifests retain a null URL and cannot be used to stage a remote update. The
release workflow builds each platform on its own native runner, then
`release-standalone-agent.py merge --output DIR DIR...` combines the
per-platform manifest directories into the pair a release publishes, one
artifact per platform, each with its URL and sha256. `butler update` selects
its own platform's entry (`darwin-arm64`), else `all`, else an unlabelled one;
an entry for another platform is never selected.

The release smoke rejects unsafe or duplicate tar entries, checks the archive
and manifest digests and identities, then installs into a temporary directory
and invokes `butler version --json` and
`butler doctor --check installation --json`. It requires native installation
provenance and all four installation checks to pass, and confirms the installed
tree and archive were not changed by those commands. Windows archives are not
produced yet.

The tag workflow (`.github/workflows/release.yml`) gates, packages, and smokes
the darwin-arm64 archive on `macos-15` (Python 3.12, Rust 1.91.0), the Linux
archives on `ubuntu-24.04` and `ubuntu-24.04-arm`, publishes them with the
merged manifests and `install.sh`, and lists all of them in
`butler-<version>-SHA256SUMS`.
