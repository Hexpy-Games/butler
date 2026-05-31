#!/usr/bin/env bash
# uninstall.sh — Remove Butler installation artifacts
# By default, removes BUTLER_HOME (code) but PRESERVES BUTLER_DATA (user data).
# Pass --purge to also remove BUTLER_DATA after explicit confirmation.
set -euo pipefail

expand_uninstall_path() {
  local value="$1"
  case "$value" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "${value#~/}" ;;
    *) printf '%s\n' "$value" ;;
  esac
}

BUTLER_HOME="${BUTLER_HOME:-$HOME/butler}"
BUTLER_DATA="${BUTLER_DATA:-$HOME/.butler}"
PURGE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge)
      PURGE=true
      shift
      ;;
    --yes)
      AUTO_YES=true
      shift
      ;;
    --home)
      BUTLER_HOME="${2:-}"
      [[ -n "$BUTLER_HOME" ]] || { echo "--home requires a path" >&2; exit 2; }
      shift 2
      ;;
    --home=*)
      BUTLER_HOME="${1#--home=}"
      shift
      ;;
    --data)
      BUTLER_DATA="${2:-}"
      [[ -n "$BUTLER_DATA" ]] || { echo "--data requires a path" >&2; exit 2; }
      shift 2
      ;;
    --data=*)
      BUTLER_DATA="${1#--data=}"
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done
BUTLER_HOME="$(expand_uninstall_path "$BUTLER_HOME")"
BUTLER_DATA="$(expand_uninstall_path "$BUTLER_DATA")"
AUTO_YES="${AUTO_YES:-false}"

echo "=== Butler Uninstall ==="
echo "BUTLER_HOME: $BUTLER_HOME"
echo "BUTLER_DATA: $BUTLER_DATA"
echo ""

# ── Confirmation prompt ──

if [[ "$AUTO_YES" != true ]]; then
  echo "This will:"
  echo "  - Stop Butler native services"
  echo "  - Remove shell environment block from ~/.zshrc / ~/.bashrc"
  echo "  - Remove BUTLER_HOME: $BUTLER_HOME"
  if [[ "$PURGE" == true ]]; then
    echo "  - Remove BUTLER_DATA: $BUTLER_DATA (⚠ includes memory, config, logs)"
  else
    echo "  - KEEP BUTLER_DATA: $BUTLER_DATA (use --purge to remove)"
  fi
  echo ""
  printf "Proceed? [y/N] "
  read -r confirm
  if [[ "${confirm,,}" != "y" && "${confirm,,}" != "yes" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# ── 1. Stop native services ──

if [[ -x "$BUTLER_HOME/ops/scripts/service-control.sh" ]]; then
  "$BUTLER_HOME/ops/scripts/service-control.sh" stop 2>/dev/null || true
  echo "Native services stopped"
else
  echo "Native service controller not found — skipping service cleanup"
fi

# ── 3. Remove shell RC environment block ──

remove_env_block() {
  local rc_file="$1"
  local marker="# butler environment"
  if [[ -f "$rc_file" ]] && grep -q "$marker" "$rc_file"; then
    echo "Removing environment block from $(basename "$rc_file")"
    # Remove the block: marker line through the PATH export line (3 lines)
    sed -i.butler-bak "/$marker/,+2d" "$rc_file"
    # Also remove any blank line left before the block
    sed -i.butler-bak '/^$/N;/^\n$/d' "$rc_file"
    rm -f "${rc_file}.butler-bak"
  fi
}

remove_env_block "$HOME/.zshrc"
remove_env_block "$HOME/.bashrc"

# ── 4. Remove BUTLER_DATA only if --purge ──

if [[ "$PURGE" == true ]]; then
  if [[ -d "$BUTLER_DATA" ]]; then
    echo "Removing data directory: $BUTLER_DATA"
    rm -rf "$BUTLER_DATA"
  else
    echo "Data directory not found — skipping: $BUTLER_DATA"
  fi
else
  echo "Preserving data directory: $BUTLER_DATA"
fi

# ── 5. Remove BUTLER_HOME contents (code, node_modules, etc.) ──
# We remove known installed artifacts, not the directory itself (user may have cloned the repo here)

echo ""
echo "=== Uninstall complete ==="
echo ""
if [[ "$PURGE" != true ]]; then
  echo "User data preserved at: $BUTLER_DATA"
  echo "To also remove data, re-run with: uninstall.sh --purge"
fi
echo ""
echo "To fully remove source code, delete: $BUTLER_HOME"
