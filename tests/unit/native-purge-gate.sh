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
  .project-ledger/references/architecture.md \
  .project-ledger/references/roles.md \
  .project-ledger/references/memory-architecture.md \
  .project-ledger/references/project-structure.md \
  .project-ledger/specs/managed-bun-runtime.md \
  .project-ledger/specs/openai-auth-and-models.md \
  .project-ledger/specs/native-product.md; do
  [[ -s "$required_doc" ]] || fail "required native product doc is missing or empty: $required_doc"
done

rg -q "Butler.*Steward.*Worker|Steward.*Worker|Worker" .project-ledger/references/roles.md \
  || fail "role documentation must describe the Butler/Steward/Worker model"
rg -q "hot cache|vector|graph|Transcript Ingestion|Maintenance Cycle" .project-ledger/references/memory-architecture.md \
  || fail "memory documentation must describe hot cache, indexes, ingestion, and maintenance"
rg -q "Source Code|Product Resources|Operations|Private Data" .project-ledger/references/project-structure.md \
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
if rg -n \
  -e "$legacy_mux" \
  -e "${legacy_mux}Session" \
  -e "$legacy_product" \
  -e "\\.${legacy_word}" \
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
rg -q 'Codex subscription login|Codex 구독 로그인' README.md .env.example install.sh .project-ledger/specs/openai-auth-and-models.md \
  || fail "Codex subscription login must be documented and installer-facing"
rg -q 'originator=butler|BUTLER_CODEX_OAUTH_ORIGINATOR|Butler-owned transport' README.md .env.example install.sh .project-ledger/specs/openai-auth-and-models.md \
  || fail "Codex subscription login must use Butler-owned identity rather than a third-party originator"
rg -q 'Butler runtime|managed runtime|BUTLER_BUN' README.md install.sh .env.example .project-ledger/specs/managed-bun-runtime.md packages/butler-agent/scripts/lib/butler-runtime.sh \
  || fail "managed Butler runtime must be documented and installer-facing"

if rg -n '\$BUTLER_HOME/\.env|\$\{BUTLER_HOME\}/\.env|join\([^)]*BUTLER_HOME[^)]*"\.env"|join\([^)]*butlerHome[^)]*"\.env"' \
  packages tools install.sh --glob '!node_modules/**'; then
  fail "private credentials must be read from \$BUTLER_DATA/.env, not \$BUTLER_HOME/.env"
fi

if rg -n '\$BUTLER_HOME/logs|\$\{BUTLER_HOME\}/logs|join\([^)]*BUTLER_HOME[^)]*"logs"|join\([^)]*butlerHome[^)]*"logs"' \
  packages tools install.sh --glob '!node_modules/**' --glob '!tests/unit/native-purge-gate.sh'; then
  fail "private logs must be written under \$BUTLER_DATA/logs, not \$BUTLER_HOME/logs"
fi

rg -q 'runTelegramPolling|Telegram polling started|getUpdates' packages/butler-agent/src/interfaces/gateway/native-butler-bootstrap.ts packages/butler-agent/src/interfaces/transport/telegram/polling-runner.ts \
  || fail "native butler-main must own the Telegram polling loop"

generic_bearer_word="bearer"
generic_bearer_env="OPENAI_B""EARER_TOKEN"
if rg -n -i \
  -e "${generic_bearer_word}[ _-]?token" \
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
