#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
crate_dir=$(cd -- "$script_dir/.." && pwd)
branch_root=$(git -C "$crate_dir" rev-parse --show-toplevel)
: "${TMPDIR:?TMPDIR must name a scratch directory}"
eval_root="$TMPDIR/hedge-v2"
rust_relative=packages/butler-agent/rust
crate_relative="$rust_relative/crates/butler-e2e"
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"

isolated() {
    local root=$1 target=$2
    shift 2
    local run_dir
    run_dir=$(mktemp -d "$eval_root/isolated.XXXXXX")
    (
        cd "$root/$rust_relative"
        export HOME="$run_dir/home" BUTLER_DATA="$run_dir/data" TMPDIR="$run_dir/tmp"
        mkdir -p "$HOME" "$BUTLER_DATA" "$TMPDIR"
        export CARGO_TARGET_DIR="$target"
        "$@"
    )
}

prepare() {
    export BUTLER_E2E_HEDGE_EVAL=1
    local sha=${1:?prepare requires main SHA}
    mkdir -p "$eval_root"
    if [[ -e "$eval_root/main" ]]; then
        [[ $(git -C "$eval_root/main" rev-parse HEAD) == $(git -C "$branch_root" rev-parse "$sha") ]] || {
            echo "existing main checkout has a different SHA" >&2; exit 1;
        }
    else
        git -C "$branch_root" worktree add --detach "$eval_root/main" "$sha"
    fi
    local source="$branch_root/$crate_relative" destination="$eval_root/main/$crate_relative"
    cp "$source/tests/e2e/live/hedge_v2.rs" "$destination/tests/e2e/live/hedge_v2.rs"
    cp -a "$source/tests/e2e/live/hedge_v2" "$destination/tests/e2e/live/"
    cp -a "$source/fixtures/hedge-v2" "$destination/fixtures/"
    cp "$source/src/e2e/hedge.rs" "$destination/src/e2e/hedge.rs"
    cp "$source/scripts/hedge_judge.py" "$destination/scripts/hedge_judge.py"
    python3 - "$destination/tests/e2e/live.rs" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1])
text=p.read_text()
if "mod hedge_v2;" not in text:
    assert "mod drift;" in text
    p.write_text(text.replace("mod drift;", "mod drift;\npub(crate) mod hedge_v2;", 1))
PY
    isolated "$eval_root/main" "$eval_root/target-main" cargo build -j 8 -p butler-agent -p butler-platform --bin butler-agent --bin butler-sandbox --features butler-platform/test-support,butler-agent/e2e-fixtures
    isolated "$branch_root" "$eval_root/target-branch" cargo build -j 8 -p butler-agent -p butler-platform --bin butler-agent --bin butler-sandbox --features butler-platform/test-support,butler-agent/e2e-fixtures
    export BUTLER_E2E_BROWSER_CACHE="$eval_root/chromium"
    isolated "$branch_root" "$eval_root/target-branch" env BUTLER_E2E_TIER=stub BUTLER_E2E_BIN="$eval_root/target-branch/debug/butler-agent" cargo test -j 8 -p butler-e2e --test e2e prewarm_shared_chromium -- --ignored --test-threads=1
    isolated "$eval_root/main" "$eval_root/target-main" cargo check -j 8 -p butler-e2e --tests
}

run() {
    export BUTLER_E2E_HEDGE_EVAL=1
    [[ ${1:-} == --rounds && ${2:-} =~ ^[1-9][0-9]*$ && $# == 2 ]] || { echo "run --rounds N" >&2; exit 1; }
    : "${BUTLER_E2E_CODEX_PROFILE:?operator must supply the dedicated Codex auth path}"
    [[ -f "$BUTLER_E2E_CODEX_PROFILE" ]] || { echo "Codex auth profile does not exist" >&2; exit 1; }
    export BUTLER_E2E_TIER=live BUTLER_E2E_PROVIDER=openai-subscription
    # HEDGE_EVAL_MODEL and HEDGE_EVAL_CASES narrow a run; both sides use the same values.
    export BUTLER_E2E_MODEL="${HEDGE_EVAL_MODEL:-openai/gpt-6.1-sol@medium}"
    export BUTLER_E2E_MODEL_MATRIX="$BUTLER_E2E_MODEL"
    export BUTLER_E2E_BROWSER_CACHE="$eval_root/chromium"
    unset OPENAI_API_KEY BUTLER_E2E_CODEX_AUTH_JSON CODEX_AUTH_JSON
    local round case side root
    for ((round=1;round<=$2;round++)); do
        for case in ${HEDGE_EVAL_CASES:-W1 W2 W3 W3N W3D M1 M1D A1 D1 D2 L1 L2 P1 C1 C2 C3 C4 C5 R1 J1 J2 U1 U2 U3 B1 B1E}; do
            for side in main branch; do
                root="$branch_root"
                [[ $side == branch ]] || root="$eval_root/main"
                isolated "$root" "$eval_root/target-$side" env BUTLER_E2E_BIN="$eval_root/target-$side/debug/butler-agent" BUTLER_E2E_HEDGE_SIDE="$side" BUTLER_E2E_HEDGE_CASES="$case" BUTLER_E2E_HEDGE_ROUND="$round" BUTLER_E2E_HEDGE_OUT="$eval_root/$side.jsonl" cargo test -j 8 -p butler-e2e --test e2e live::hedge_v2::live_12_hedge_v2 -- --ignored --exact --test-threads=1
            done
        done
    done
}

case ${1:-} in
    prepare) shift; prepare "$@" ;;
    run) shift; run "$@" ;;
    judge)
        : "${JEV_KEY:?JEV_KEY is required}"
        for side in main branch; do
            python3 "$script_dir/hedge_judge.py" --mode eval --out "$eval_root/$side-judged.jsonl" "$eval_root/$side.jsonl"
        done ;;
    pairs) python3 "$script_dir/hedge_eval_v2_report.py" "$eval_root/main.jsonl" "$eval_root/branch.jsonl" --pairs --out "$eval_root" ;;
    report)
        inputs=()
        for item in pairs owner; do
            [[ ! -f "$eval_root/${item}_verdicts.jsonl" ]] || inputs+=("--${item}-verdicts" "$eval_root/${item}_verdicts.jsonl")
        done
        [[ ${#inputs[@]} == 0 ]] || inputs+=(--pairs-key "$eval_root/pairs_key.json")
        main_input="$eval_root/main.jsonl"; branch_input="$eval_root/branch.jsonl"
        if [[ -f "$eval_root/main-judged.jsonl" && -f "$eval_root/branch-judged.jsonl" ]]; then
            main_input="$eval_root/main-judged.jsonl"; branch_input="$eval_root/branch-judged.jsonl"
        fi
        python3 "$script_dir/hedge_eval_v2_report.py" "$main_input" "$branch_input" --out "$eval_root/report.json" "${inputs[@]}" ;;
    *) echo "Usage: $0 prepare <main_sha> | run --rounds N | judge | pairs | report (prepare/run opt in with BUTLER_E2E_HEDGE_EVAL=1)" >&2; exit 1 ;;
esac
