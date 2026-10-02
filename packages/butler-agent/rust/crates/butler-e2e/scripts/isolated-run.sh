#!/usr/bin/env bash
# Isolate a test/check command without leaking its HOME or BUTLER_DATA.
set -euo pipefail
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
run_root=$(mktemp -d "${TMPDIR:-/tmp}/butler-e2e-run.XXXXXX")
trap 'rm -rf "$run_root"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export HOME="$run_root/home" BUTLER_DATA="$run_root/data"
mkdir -p "$HOME" "$BUTLER_DATA"
"$@"
