#!/usr/bin/env bash
# Butler-managed runtime resolver.

butler_runtime_home() {
  printf '%s\n' "${BUTLER_HOME:-$HOME/butler}"
}

butler_runtime_data() {
  printf '%s\n' "${BUTLER_DATA:-$HOME/.butler}"
}

butler_bun_pinned_version() {
  local home version_file
  home="$(butler_runtime_home)"
  version_file="$home/packages/butler-agent/resources/runtime/bun-version"
  if [[ ! -f "$version_file" ]]; then
    version_file="$home/resources/runtime/bun-version"
  fi
  if [[ -f "$version_file" ]]; then
    tr -d '[:space:]' < "$version_file"
  else
    printf '%s\n' "1.3.11"
  fi
}

butler_bun_root() {
  printf '%s\n' "$(butler_runtime_data)/runtime/bun"
}

butler_bun_current_bin() {
  printf '%s\n' "$(butler_bun_root)/current/bin/bun"
}

butler_bun_versioned_bin() {
  local version="${1:-$(butler_bun_pinned_version)}"
  printf '%s\n' "$(butler_bun_root)/$version/bin/bun"
}

butler_resolve_bun() {
  if [[ -n "${BUTLER_BUN:-}" && -x "$BUTLER_BUN" ]]; then
    printf '%s\n' "$BUTLER_BUN"
    return 0
  fi

  local current
  current="$(butler_bun_current_bin)"
  if [[ -x "$current" ]]; then
    printf '%s\n' "$current"
    return 0
  fi

  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi

  return 1
}

butler_use_runtime() {
  local bun_bin
  bun_bin="$(butler_resolve_bun)" || return 1
  export BUTLER_BUN="$bun_bin"
  export PATH="$(dirname "$bun_bin"):$PATH"
}
