#!/usr/bin/env bash
set -euo pipefail

VERBOSE=false
if [[ "${BUTLER_VALIDATE_VERBOSE:-}" == "1" ]]; then VERBOSE=true; fi
for arg in "$@"; do
  case "$arg" in
    --verbose) VERBOSE=true ;;
    --silent|--quiet) VERBOSE=false ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

export BUTLER_HOME="$TMP_DIR/home"
export BUTLER_DATA="$TMP_DIR/data"
mkdir -p "$BUTLER_HOME/packages/butler-agent/resources/runtime" "$BUTLER_DATA/runtime/bun"
cp "$ROOT_DIR/packages/butler-agent/scripts/lib/butler-runtime.sh" "$TMP_DIR/butler-runtime.sh"
echo "9.9.9" > "$BUTLER_HOME/packages/butler-agent/resources/runtime/bun-version"

# shellcheck source=/dev/null
source "$TMP_DIR/butler-runtime.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ "$(butler_bun_pinned_version)" == "9.9.9" ]] || fail "pinned version not read from packages/butler-agent/resources/runtime/bun-version"

mkdir -p "$BUTLER_DATA/runtime/bun/9.9.9/bin"
cat > "$BUTLER_DATA/runtime/bun/9.9.9/bin/bun" <<'FAKEBUN'
#!/usr/bin/env bash
echo "9.9.9"
FAKEBUN
chmod +x "$BUTLER_DATA/runtime/bun/9.9.9/bin/bun"
ln -s "9.9.9" "$BUTLER_DATA/runtime/bun/current"

unset BUTLER_BUN
resolved="$(butler_resolve_bun)"
[[ "$resolved" == "$BUTLER_DATA/runtime/bun/current/bin/bun" ]] || fail "managed current should resolve before system bun"

override="$TMP_DIR/custom-bun"
cat > "$override" <<'FAKEBUN'
#!/usr/bin/env bash
echo "custom"
FAKEBUN
chmod +x "$override"
export BUTLER_BUN="$override"
resolved="$(butler_resolve_bun)"
[[ "$resolved" == "$override" ]] || fail "BUTLER_BUN override should win"

butler_use_runtime || fail "butler_use_runtime should export resolved runtime"
[[ "${PATH%%:*}" == "$(dirname "$override")" ]] || fail "runtime bin directory should be prepended to PATH"

repair_data="$TMP_DIR/repair-data"
repo_home="$ROOT_DIR"
pinned="$(tr -d '[:space:]' < "$repo_home/packages/butler-agent/resources/runtime/bun-version")"
mkdir -p "$repair_data/runtime/bun/$pinned/bin"
cat > "$repair_data/runtime/bun/$pinned/bin/bun" <<'FAKEBUN'
#!/usr/bin/env bash
echo "1.3.11"
FAKEBUN
chmod +x "$repair_data/runtime/bun/$pinned/bin/bun"
unset BUTLER_BUN
BUTLER_DATA="$repair_data" BUTLER_HOME="$repo_home" bash "$repo_home/install.sh" --runtime-repair --home "$repo_home" --data "$repair_data" >/dev/null
[[ -L "$repair_data/runtime/bun/current" ]] || fail "runtime repair should create current pointer"
[[ -x "$repair_data/runtime/bun/current/bin/bun" ]] || fail "runtime repair should preserve existing pinned runtime"

if [[ "$VERBOSE" == true ]]; then
  echo "PASS: managed bun runtime"
fi
