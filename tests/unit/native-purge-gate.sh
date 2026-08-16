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
cd "$ROOT_DIR"

if ! command -v rg >/dev/null 2>&1; then
  rg() {
    local quiet=false
    local line_numbers=false
    local ignore_case=false
    local patterns=()
    local paths=()

    while [[ "$#" -gt 0 ]]; do
      case "$1" in
        -q)
          quiet=true
          ;;
        -n)
          line_numbers=true
          ;;
        -i)
          ignore_case=true
          ;;
        -e)
          shift
          patterns+=("$1")
          ;;
        --glob)
          shift
          ;;
        --glob=*)
          ;;
        --)
          ;;
        -*)
          ;;
        *)
          if [[ "${#patterns[@]}" -eq 0 ]]; then
            patterns+=("$1")
          else
            paths+=("$1")
          fi
          ;;
      esac
      shift
    done

    [[ "${#patterns[@]}" -gt 0 ]] || return 2
    [[ "${#paths[@]}" -gt 0 ]] || paths=(".")

    local joined_pattern
    joined_pattern="$(printf '%s\n' "${patterns[@]}" | paste -sd '|' -)"
    local grep_args=(-E -I --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=data --exclude-dir=.project-ledger --exclude=native-purge-gate.sh)
    if [[ "$quiet" == true ]]; then grep_args+=(-q); fi
    if [[ "$line_numbers" == true ]]; then grep_args+=(-n); fi
    if [[ "$ignore_case" == true ]]; then grep_args+=(-i); fi

    grep "${grep_args[@]}" -R -- "$joined_pattern" "${paths[@]}"
  }
fi

LEDGER_ROOT="${PROJECT_LEDGER_ROOT:-}"
if [[ -z "$LEDGER_ROOT" && -n "${BUTLER_DATA:-}" && -s "$BUTLER_DATA/project-ledger/projects/butler/project.json" ]]; then
  LEDGER_ROOT="$BUTLER_DATA/project-ledger/projects/butler"
fi
if [[ -z "$LEDGER_ROOT" && -s "$HOME/.butler/project-ledger/projects/butler/project.json" ]]; then
  LEDGER_ROOT="$HOME/.butler/project-ledger/projects/butler"
fi
if [[ -z "$LEDGER_ROOT" ]]; then
  LEDGER_ROOT=".project-ledger"
fi

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

if git ls-files data | grep -q .; then
  git ls-files data >&2
  fail "data/ must not be tracked"
fi

for private_root_dir in data tasks logs config; do
  [[ ! -e "$private_root_dir" ]] || fail "$private_root_dir/ must not exist in the checkout; private runtime state belongs under \$BUTLER_DATA"
done

[[ ! -e .env ]] || fail ".env must not exist in the checkout; private credentials belong under \$BUTLER_DATA/.env"

for required_doc in \
  references/architecture.md \
  references/roles.md \
  references/memory-architecture.md \
  references/project-structure.md \
  specs/managed-bun-runtime.md \
  specs/openai-auth-and-models.md \
  specs/native-product.md; do
  required_path="$LEDGER_ROOT/$required_doc"
  [[ -s "$required_path" ]] || fail "required native product doc is missing or empty: .project-ledger/$required_doc"
done

rg -q "Butler.*Steward.*Worker|Steward.*Worker|Worker" "$LEDGER_ROOT/references/roles.md" \
  || fail "role documentation must describe the Butler/Steward/Worker model"
rg -q "hot cache|vector|graph|Transcript Ingestion|Maintenance Cycle" "$LEDGER_ROOT/references/memory-architecture.md" \
  || fail "memory documentation must describe hot cache, indexes, ingestion, and maintenance"
rg -q "Source Code|Product Resources|Operations|Private Data" "$LEDGER_ROOT/references/project-structure.md" \
  || fail "project structure documentation must describe active source areas and private data"

for required_root_dir in packages tools tests; do
  [[ -d "$required_root_dir" ]] || fail "required root directory is missing: $required_root_dir"
done
for required_package_dir in \
  packages/butler-agent/src \
  packages/butler-agent/resources \
  packages/butler-app/client \
  packages/butler-agent/src/gateways/app \
  packages/project-ledger; do
  [[ -d "$required_package_dir" ]] || fail "required package directory is missing: $required_package_dir"
done

[[ ! -f ecosystem.config.cjs ]] || fail "PM2 ecosystem config must not exist in the native product path"
[[ ! -f ecosystem.config.js ]] || fail "ecosystem.config.js must not exist because package.json type=module treats it as ESM"

for removed_root_dir in docs artifacts ops gateway harness runtime transport memory prompts skills personas templates scripts test mcp-server plugins butler-skills; do
  if [[ "$removed_root_dir" == "docs" && -d docs/reports ]]; then
    # Audited product reports are the only supported top-level docs surface;
    # all other legacy docs remain prohibited by this gate.
    if find docs -mindepth 1 -maxdepth 1 ! -name reports -print -quit | grep -q .; then
      fail "legacy top-level docs entries must not exist outside docs/reports"
    fi
    continue
  fi
  [[ ! -e "$removed_root_dir" ]] || fail "legacy top-level directory must not exist: $removed_root_dir"
done

role_prefix="butler-""role-"
for role_dir in "butler-""core" "${role_prefix}butler" "${role_prefix}steward" "${role_prefix}worker"; do
  if [[ -e "$role_dir" ]]; then
    fail "role plugin directory must not exist: $role_dir"
  fi
done

legacy_word="$(printf '%b' '\143\154\141\165\144\145')"
legacy_prompt_name="$(printf '%b' '\103\114\101\125\104\105.md')"
legacy_hidden_glob="*/.${legacy_word}*"
legacy_plugin_glob="*/.${legacy_word}-plugin/*"

if find . -path './node_modules' -prune -o -path './data' -prune -o \
  \( -name "$legacy_prompt_name" -o -path "$legacy_hidden_glob" -o -path "$legacy_plugin_glob" \) -print | grep -q .; then
  find . -path './node_modules' -prune -o -path './data' -prune -o \
    \( -name "$legacy_prompt_name" -o -path "$legacy_hidden_glob" -o -path "$legacy_plugin_glob" \) -print >&2
  fail "legacy prompt/plugin artifacts are present"
fi

legacy_mux="$(printf '%b' '\164\155\165\170')"
legacy_product="butler-${legacy_word}"
# Match hidden legacy paths as path-like tokens. A provider's official source
# URL (for example, platform.claude.com) is not a legacy hidden artifact and
# must not be rejected merely because its hostname contains the product word.
legacy_dot_path="([/[:space:]\"'()]|^)\\.${legacy_word}([/[:space:]\"'()]|$)"
if rg -n \
  -e "$legacy_mux" \
  -e "${legacy_mux}Session" \
  -e "$legacy_product" \
  -e "$legacy_dot_path" \
  --glob '!node_modules/**' --glob '!data/**' \
  --glob '!.project-ledger/plans/plan-autonomous-planned-dispatch.md' \
  --glob '!.project-ledger/specs/autonomous-planned-dispatch.md' \
  .; then
  fail "legacy runtime or product references are present"
fi

rg -q 'BUTLER_HOME=.*~/butler|BUTLER_HOME.*\$HOME/butler|butlerHome.*~/butler' README.md install.sh butler.config.template.json \
  || fail "default code/runtime home must be documented as ~/butler"
rg -q 'BUTLER_DATA=.*~/.butler|BUTLER_DATA.*\$HOME/.butler|butlerData.*~/.butler' README.md install.sh butler.config.template.json \
  || fail "default private state root must be documented as ~/.butler"
rg -q 'gpt-5\.5-codex' README.md install.sh butler.config.template.json packages/butler-agent/src/integrations/providers/provider.ts \
  || fail "concrete Codex model default must be documented and wired"
if rg -n 'auto:codex-latest' install.sh butler.config.template.json; then
  fail "legacy auto Codex alias must not be used as an install or template default"
fi
rg -q 'Codex subscription login|Codex 구독 로그인' README.md .env.example install.sh "$LEDGER_ROOT/specs/openai-auth-and-models.md" \
  || fail "Codex subscription login must be documented and installer-facing"
rg -q 'originator=butler|BUTLER_CODEX_OAUTH_ORIGINATOR|Butler-owned transport' README.md .env.example install.sh "$LEDGER_ROOT/specs/openai-auth-and-models.md" \
  || fail "Codex subscription login must use Butler-owned identity rather than a third-party originator"
rg -q 'Butler runtime|managed runtime|BUTLER_BUN' README.md install.sh .env.example "$LEDGER_ROOT/specs/managed-bun-runtime.md" packages/butler-agent/scripts/lib/butler-runtime.sh \
  || fail "managed Butler runtime must be documented and installer-facing"

if rg -n '\$BUTLER_HOME/\.env|\$\{BUTLER_HOME\}/\.env|join\([^)]*BUTLER_HOME[^)]*"\.env"|join\([^)]*butlerHome[^)]*"\.env"' \
  packages tools install.sh --glob '!node_modules/**'; then
  fail "private credentials must be read from \$BUTLER_DATA/.env, not \$BUTLER_HOME/.env"
fi

if rg -n '\$BUTLER_HOME/logs|\$\{BUTLER_HOME\}/logs|join\([^)]*BUTLER_HOME[^)]*"logs"|join\([^)]*butlerHome[^)]*"logs"' \
  packages tools install.sh --glob '!node_modules/**' --glob '!tests/unit/native-purge-gate.sh'; then
  fail "private logs must be written under \$BUTLER_DATA/logs, not \$BUTLER_HOME/logs"
fi

generic_bearer_env="OPENAI_B""EARER_TOKEN"
if rg -n -i \
  -e "$generic_bearer_env" \
  --glob '!node_modules/**' --glob '!data/**' --glob '!tests/unit/native-purge-gate.sh' .; then
  fail "generic OpenAI raw-token auth must not be offered in active product surfaces"
fi

if rg -n \
  -e 'BUTLER_HOME="[^"]*\.butler' \
  -e '"butlerHome"[^,}]*\.butler' \
  -e 'ecosystem\.config\.js' \
  --glob '!node_modules/**' --glob '!data/**' --glob '!tests/unit/native-purge-gate.sh' .; then
  fail "active install defaults must not use ~/.butler as the code/runtime home"
fi

if rg -n -i \
  -e '\bpm2\b' \
  -e 'cron_restart' \
  -e 'ecosystem\.config\.cjs' \
  --glob '!node_modules/**' \
  --glob '!data/**' \
  --glob '!tests/unit/native-purge-gate.sh' \
  --glob '!.project-ledger/specs/native-service-supervisor.md' \
  --glob '!.project-ledger/plans/plan-native-service-supervisor.md' \
  --glob '!.project-ledger/reports/native-service-supervisor-*.md' .; then
  fail "PM2 references must not exist outside the native service supervisor history/spec allowlist"
fi

if [[ "$VERBOSE" == true ]]; then
  echo "PASS: native purge gate"
fi
