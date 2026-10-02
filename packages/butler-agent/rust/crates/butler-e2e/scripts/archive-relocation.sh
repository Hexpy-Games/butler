#!/usr/bin/env bash
# Run from packages/butler-agent/rust after building the agent and E2E archive.
set -euo pipefail
archive=$1
extract=$(mktemp -d "${TMPDIR:-/tmp}/butler-e2e-archive.XXXXXX")
trap 'rm -rf "$extract"' EXIT
export BUTLER_E2E_ARCHIVE_ROOT="$extract"
crates/butler-e2e/scripts/isolated-run.sh cargo nextest run \
  --archive-file "$archive" --extract-to "$extract" \
  --workspace-remap "$PWD" --retries 0 --test-threads=8 --success-output immediate \
  -E 'test(mcp_fixture_uses_the_runtime_archive_path) or test(stop_reaps_a_hung_mcp_server_and_releases_the_instance)'
