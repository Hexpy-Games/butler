use butler_work::work_types::*;

pub(super) fn roundtrips_match_sql() {
    assert!("remote".parse::<CanonStatusSource>().is_err());
    assert!("github".parse::<Origin>().is_err());
    macro_rules! pin {
        ($ty:ident, $table:literal, $column:literal) => {{
            let values = $ty::ALL
                .iter()
                .map(|v| {
                    let wire = v.as_str();
                    assert_eq!(wire.parse::<$ty>().unwrap(), *v);
                    assert_eq!(serde_json::to_string(v).unwrap(), format!("\"{wire}\""));
                    assert_eq!(
                        serde_json::from_str::<$ty>(&format!("\"{wire}\"")).unwrap(),
                        *v
                    );
                    format!("'{wire}'")
                })
                .collect::<Vec<_>>()
                .join(",");
            let sql = super::enum_columns::COLUMNS
                .iter()
                .find(|(t, c, _)| *t == $table && *c == $column)
                .unwrap()
                .2;
            assert_eq!(values, sql);
            assert!("unknown".parse::<$ty>().is_err());
        }};
    }
    pin!(RunState, "wm_works", "run_state");
    pin!(CanonStatus, "wm_works", "canon_status");
    pin!(CanonStatusSource, "wm_works", "canon_status_source");
    pin!(HoldReason, "wm_works", "hold_reason");
    pin!(QueueOrigin, "wm_works", "queue_origin");
    pin!(Origin, "wm_works", "origin");
    pin!(Visibility, "wm_works", "visibility");
    pin!(ScopeKind, "wm_works", "scope_kind");
    pin!(ChainState, "wm_work_chains", "state");
    pin!(Decision, "wm_hold_decisions", "decision");
    pin!(PlanStatus, "wm_plans", "status");
    pin!(TaskStatus, "wm_tasks", "status");
    pin!(TaskKind, "wm_tasks", "kind");
    pin!(AttemptStatus, "wm_attempts", "status");
    pin!(InstructionStatus, "wm_instructions", "status");
    pin!(InstructionMode, "wm_instructions", "mode");
    pin!(AnchorKind, "wm_instructions", "anchor_kind");
    pin!(ExecutionPhase, "wm_session_exec", "phase");
    pin!(ControlState, "wm_session_exec", "control_state");
    pin!(HoldKind, "wm_holds", "kind");
    pin!(IntentState, "wm_cross_db_intents", "state");
    pin!(SpecSource, "wm_spec_nodes", "source");
    pin!(SpecState, "wm_spec_revisions", "state");
    pin!(SpecLifecycle, "wm_spec_nodes", "lifecycle");
    pin!(MigrationState, "wm_migration", "state");
    pin!(ReviewVerdict, "wm_reviews", "verdict");
    pin!(ScopeKind, "wm_counts", "scope_kind");
}
