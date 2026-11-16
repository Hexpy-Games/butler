#!/usr/bin/env bash
# Regenerate the mobile design tokens from tokens.css; --check only verifies them.
# ds-tokens is std-only, so plain rustc builds it without resolving the gpui workspace.
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
bin="${TMPDIR:-/tmp}/ds-tokens"
rustc --edition 2024 -o "$bin" packages/butler-shell/tools/ds-tokens/src/main.rs
"$bin" "$@" --mobile \
  packages/butler-app/client/ui/src/libs/design-system/tokens.css \
  packages/butler-mobile/src/design/tokens.generated.json
