#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

tests=()
while IFS= read -r test_file; do
  case "$test_file" in
    tests/unit/app-first-run-smoke-script.test.ts|\
    tests/unit/app-managed-runtime.test.ts|\
    tests/unit/install-service-registration.test.ts|\
    tests/unit/install-upgrade.test.ts|\
    tests/unit/release-packaging.test.ts|\
    tests/unit/release-workflow.test.ts)
      ;;
    *)
      tests+=("$test_file")
      ;;
  esac
done < <(find tests/unit -maxdepth 1 -name "*.test.ts" -print | sort)

if [[ "${#tests[@]}" -eq 0 ]]; then
  echo "No fast unit tests found." >&2
  exit 1
fi

if [[ "${1:-}" == "--list" ]]; then
  printf '%s\n' "${tests[@]}"
  exit 0
fi

exec "${BUTLER_BUN:-bun}" test "${tests[@]}"
