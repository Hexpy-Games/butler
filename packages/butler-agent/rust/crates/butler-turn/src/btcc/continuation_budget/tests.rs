use serde_json::json;

use super::*;

#[test]
fn rounds_are_accounted_without_becoming_terminal_limits() {
    let limits = TurnContinuationBudgetLimits {
        max_model_requests: 1,
        max_tool_rounds: 1,
        max_model_facing_bytes: 100,
        max_cumulative_model_facing_bytes: 200,
        max_output_bytes: 100,
        max_elapsed_ms: 1_000,
        max_idle_ms: 1_000,
        extensions: Default::default(),
    };
    let mut state =
        create_turn_continuation_budget_state("turn-1".into(), limits, 10).expect("create state");
    for index in 0..3 {
        state = transition_turn_continuation_budget(
            state,
            TurnContinuationBudgetEvent::AdmitRequest {
                round_id: format!("round-{index}"),
                request_digest: format!("{index:064x}"),
                model_facing_bytes: 1,
            },
            11 + index,
        )
        .expect("round count is retained only for compatibility");
        state = transition_turn_continuation_budget(
            state,
            TurnContinuationBudgetEvent::RecordToolRound {
                round_id: format!("round-{index}"),
            },
            20 + index,
        )
        .expect("tool round count is retained only for compatibility");
    }
    assert_eq!(state.admitted_requests.len(), 3);
    assert_eq!(state.completed_tool_rounds.len(), 3);
    assert!(state.terminal.is_none());
}

#[test]
fn cumulative_exhaustion_retains_consumption_and_unknown_fields() {
    let value = json!({
        "schemaVersion":"butler.turn-continuation-budget.v2", "turnId":"turn-1",
        "limits":{"maxModelRequests":2,"maxToolRounds":2,"maxModelFacingBytes":5,
            "maxCumulativeModelFacingBytes":5,"maxOutputBytes":5,"maxElapsedMs":1000,
            "maxIdleMs":1000,"futureLimit":"kept"},
        "admittedRequests":[],"completedOutputRounds":[],"completedToolRounds":[],
        "consumedOutputBytes":0,"consumedModelFacingBytes":0,"startedAtMs":10,
        "lastProgressAtMs":10,"terminal":null,"futureState":"kept"
    });
    let state = validate_turn_continuation_budget_state(
        serde_json::from_value(value).expect("decode extensions"),
        "turn-1",
    )
    .expect("parse extensions");
    let error = transition_turn_continuation_budget(
        state,
        TurnContinuationBudgetEvent::RecordOutput {
            round_id: "round-1".into(),
            output_bytes: 6,
        },
        11,
    )
    .expect_err("output bytes exhaust");
    let state = error.exhausted_state().expect("terminal state");
    assert_eq!(state.consumed_output_bytes, 6);
    assert_eq!(state.extensions["futureState"], "kept");
    assert_eq!(state.limits.extensions["futureLimit"], "kept");
    assert_eq!(
        state.terminal.as_ref().expect("terminal").reason,
        TurnContinuationBudgetTerminalReason::MaxOutputBytes
    );
}
