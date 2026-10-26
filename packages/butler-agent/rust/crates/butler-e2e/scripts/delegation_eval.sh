#!/usr/bin/env bash
# Owner-run only. Does not record cassettes or alter the current branch.
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
crate_dir=$(cd -- "$script_dir/.." && pwd)
repo=$(git -C "$crate_dir" rev-parse --show-toplevel)
rust="$repo/packages/butler-agent/rust"
eval_root="${BUTLER_E2E_DELEGATION_ROOT:-${TMPDIR:-/tmp}/delegation-eval}"
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export BUTLER_E2E_DELEGATION_EVAL=1
unset BUTLER_E2E_RECORD
mkdir -p "$eval_root"
new_target="${CARGO_TARGET_DIR:-$rust/target}"
mkdir -p "$new_target"
new_target=$(cd "$new_target" && pwd)

build_agent() {
    local root=$1 target=$2
    (cd "$root/packages/butler-agent/rust"
     CARGO_TARGET_DIR="$target" "$script_dir/isolated-run.sh" cargo build -j 2 -p butler-agent -p butler-platform \
       --bin butler-agent --bin butler-sandbox --features butler-agent/e2e-fixtures,butler-platform/test-support)
}
prepare() {
    local base scratch
    base=$(git -C "$repo" merge-base HEAD origin/main)
    scratch=$(mktemp -d "$eval_root/old.XXXXXX")
    rmdir "$scratch"
    git -C "$repo" worktree add --detach "$scratch" "$base"
    trap 'git -C "$repo" worktree remove "$scratch"' EXIT
    build_agent "$scratch" "$eval_root/target-old"
    git -C "$repo" worktree remove "$scratch"
    trap - EXIT
    build_agent "$repo" "$new_target"
    printf '%s\n' "$base" > "$eval_root/old-sha"
}

command=${1:-}; shift || true
if [[ $command == prepare ]]; then prepare; exit; fi
[[ $command == first-decision || $command == steward || $command == self-test ]] || {
    echo 'Usage: delegation_eval.sh prepare | first-decision|steward --model provider/model [--variants old,new] [--cases id,id] [--repeat N] [--max-rounds 80] [--seconds 900] | self-test' >&2; exit 1;
}
model='' variants='old,new' cases='' repeat=1 max_rounds=80 seconds=900
while (($#)); do
    [[ $# -ge 2 ]] || { echo 'missing option value' >&2; exit 1; }
    case $1 in
        --model) model=$2;; --variants) variants=$2;; --cases) cases=$2;; --repeat) repeat=$2;;
        --max-rounds) max_rounds=$2;; --seconds) seconds=$2;; *) echo "unknown option: $1" >&2; exit 1;;
    esac
    shift 2
done
for n in "$repeat" "$max_rounds" "$seconds"; do [[ $n =~ ^[1-9][0-9]*$ ]] || { echo 'limits must be positive integers' >&2; exit 1; }; done
if [[ $command != self-test ]]; then
    [[ $model == */* ]] || { echo '--model provider/model required' >&2; exit 1; }
    export BUTLER_E2E_TIER=live BUTLER_E2E_MODEL="$model" BUTLER_E2E_MODEL_MATRIX="$model"
    if [[ $model == openai/* ]]; then
        export BUTLER_E2E_PROVIDER=openai-subscription
        : "${BUTLER_E2E_CHATGPT_AUTH_DIR:?dedicated ChatGPT auth directory required}"
        [[ -f "$BUTLER_E2E_CHATGPT_AUTH_DIR/chatgpt.json" ]] || { echo 'dedicated ChatGPT sign-in missing' >&2; exit 1; }
        unset OPENAI_API_KEY
    else
        export BUTLER_E2E_PROVIDER="${model%%/*}"
        export BUTLER_E2E_API_KEY_ENV="${BUTLER_E2E_API_KEY_ENV:-ANTHROPIC_API_KEY}"
        [[ -n ${!BUTLER_E2E_API_KEY_ENV:-} ]] || { echo 'live API key environment variable is empty' >&2; exit 1; }
    fi
fi
out=$(mktemp -d "$eval_root/$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
touch "$out/raw.jsonl"
summarize() {
    "$script_dir/isolated-run.sh" python3.12 "$script_dir/delegation_eval_report.py" "$out/raw.jsonl" \
        --catalog "$rust/crates/butler-models/src/models/catalog/static-catalog.json" --out "$out"
}
trap summarize EXIT
export BUTLER_E2E_DELEGATION_OUT="$out/raw.jsonl" BUTLER_E2E_DELEGATION_MAX_ROUNDS="$max_rounds" BUTLER_E2E_DELEGATION_SECONDS="$seconds"
run_test() {
    local filter=$1
    (cd "$rust"
     CARGO_TARGET_DIR="$new_target" "$script_dir/isolated-run.sh" cargo test -j 2 -p butler-e2e --test delegation_eval "$filter" -- --ignored --exact --test-threads=1 --nocapture)
}
if [[ $command == self-test ]]; then
    unset BUTLER_E2E_DELEGATION_WIRE
    export BUTLER_E2E_TIER=stub BUTLER_E2E_BIN="$new_target/debug/butler-agent" BUTLER_E2E_DELEGATION_VARIANT=new
    export BUTLER_E2E_DELEGATION_DUMMY_KEY=dummy-offline-key
    run_test delegation_contracts
    export BUTLER_E2E_DELEGATION_MODE=first-decision BUTLER_E2E_DELEGATION_CASES=d03-pdf-from-above,s06-thanks
    run_test delegation_offline
    export BUTLER_E2E_DELEGATION_WIRE=final BUTLER_E2E_DELEGATION_REPEAT=2
    run_test delegation_offline
    unset BUTLER_E2E_DELEGATION_WIRE
    export BUTLER_E2E_DELEGATION_REPEAT=1
    export BUTLER_E2E_DELEGATION_MODE=steward BUTLER_E2E_DELEGATION_CASES=w07-small-fix
    run_test delegation_offline
    export BUTLER_E2E_DELEGATION_VARIANT=old
    run_test delegation_offline
else
    IFS=',' read -r -a sides <<< "$variants"
    fixture_name=first-decision-cases.json
    [[ $command != steward ]] || fixture_name=steward-cases.json
    if [[ -z $cases ]]; then
        cases=$(python3.12 -c 'import json,sys; print(",".join(c["id"] for c in json.load(open(sys.argv[1]))["cases"]))' "$crate_dir/fixtures/delegation-eval/$fixture_name")
    fi
    IFS=',' read -r -a case_ids <<< "$cases"
    for ((i=1;i<=repeat;i++)); do
        for id in "${case_ids[@]}"; do
            for side in "${sides[@]}"; do
                case $side in
                    old) export BUTLER_E2E_BIN="$eval_root/target-old/debug/butler-agent";;
                    new) export BUTLER_E2E_BIN="$new_target/debug/butler-agent";;
                    *) echo 'variants must be old,new' >&2; exit 1;;
                esac
                [[ -x $BUTLER_E2E_BIN ]] || { echo 'run prepare first' >&2; exit 1; }
                export BUTLER_E2E_DELEGATION_VARIANT="$side" BUTLER_E2E_DELEGATION_MODE="$command" BUTLER_E2E_DELEGATION_CASES="$id"
                export BUTLER_E2E_DELEGATION_REPEAT=$i
                run_test delegation_live
            done
        done
    done
fi
