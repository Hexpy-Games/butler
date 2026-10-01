#!/usr/bin/env bash
set -euo pipefail

# Run from the Rust workspace after building butler-agent and butler-e2e.
rounds="${1:-3}"
parallel="${2:-4}"
export BUTLER_E2E_TIER=stub BUTLER_E2E_SKIP_BUILD=1

for ((round = 1; round <= rounds; round++)); do
  pids=()
  for ((slot = 1; slot <= parallel; slot++)); do
    cargo test --locked -p butler-e2e --test wallpapers \
      wall_03_module_ids_and_files_stay_inside_the_module_folder -- --exact &
    pids+=("$!")
    cargo test --locked -p butler-e2e --test onboarding \
      onb_02_provider_401_fails_without_retry_storm -- --exact &
    pids+=("$!")
  done
  failed=0
  for pid in "${pids[@]}"; do
    wait "$pid" || failed=1
  done
  if ((failed)); then
    echo "ETXTBSY stress round $round/$rounds failed" >&2
    exit 1
  fi
  echo "ETXTBSY stress round $round/$rounds passed ($parallel parallel pairs)"
done
