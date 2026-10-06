#!/usr/bin/env bash
# Host acceptance: real signed fixture bundles, stub feed/provider, private DATA.
# Never reads or controls the installed Butler or its service.
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/../.." && pwd)
run_root=$(mktemp -d "${TMPDIR:-/tmp}/butler-update-host.XXXXXX")
trap 'rm -rf "$run_root"' EXIT
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export HOME="$run_root/home" BUTLER_DATA="$run_root/data" TMPDIR="$run_root/tmp"
mkdir -p "$HOME" "$BUTLER_DATA" "$TMPDIR"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$run_root/target}"
export BUTLER_UPDATE_SMOKE_PROFILE="${BUTLER_UPDATE_SMOKE_PROFILE:-dev}"
export BUTLER_UPDATE_SMOKE_BUNDLE_CACHE="$run_root/bundles"
cd "$repo_root"
bun install --frozen-lockfile --ignore-scripts
bun run --cwd packages/butler-app/client/electron install-electron --no
npm --prefix packages/butler-app/client/ui run build
bunx playwright install chromium
bun run tests/smoke/app-update-choice-smoke.ts
if [[ -z "${ORT_LIB_PATH:-}" && -z "${BUTLER_UPDATE_SMOKE_FROM_BUNDLE:-}" && -z "${BUTLER_UPDATE_SMOKE_AGENT_BUILDS:-}" ]]; then
  python3 packages/butler-agent/rust/scripts/prepare-static-ort.py > "$run_root/ort.json"
  ORT_LIB_PATH=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ort_lib_path"])' "$run_root/ort.json")
  PROTOC=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["protoc"])' "$run_root/ort.json")
  export ORT_LIB_PATH PROTOC ORT_SKIP_DOWNLOAD=1 ORT_PREFER_DYNAMIC_LINK=0
fi
for scenario in idle now defer background-quit; do
  BUTLER_UPDATE_SMOKE_WORK="$scenario" bun run tests/smoke/packaged-app-update.ts
done
