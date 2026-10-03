//! Serialized surface ratchets extend the existing role/phase wire fixtures.
use super::*;
use butler_turn::btcc::GuidedPhaseSelection;

fn measurement(phase: &GuidedPhaseSelection) -> (usize, usize, usize) {
    let tools = phase
        .provider_tools
        .iter()
        .filter(|t| {
            t["name"]
                .as_str()
                .is_some_and(crate::host::GuidedTools::supports)
        })
        .collect::<Vec<_>>();
    let tools_json = serde_json::to_string(&tools).unwrap();
    let text = format!("{}{}", phase.stable_instruction_prefix, tools_json);
    let tokens = tiktoken_rs::cl100k_base()
        .unwrap()
        .encode_with_special_tokens(&text)
        .len();
    (text.len(), tools.len(), tokens)
}

fn check(
    turn: &TurnRecord,
    catalog: &butler_turn::btcc::GuidedCatalogSnapshot,
    flag: &str,
    replay: &str,
) {
    for tier in 0..=2 {
        let mut phase = select_phase(GuidedPhaseInput {
            turn,
            catalog,
            phase_surface_flag: flag,
            operation_replay_flag: replay,
            default_workspace: "/tmp",
        })
        .unwrap();
        if tier > 0 && phase.execution_policy.tracking_mode == "none" {
            continue;
        }
        let baseline = measurement(&phase);
        let nested =
            tier == 2 && phase.execution_policy.role == butler_turn::btcc::PolicyRole::Worker;
        crate::host::guided::work_model::surface(
            &mut phase,
            &json!({"tier":tier,"status":"active","current_task":{"allow_nested_delegation":nested}}),
        );
        let core = measurement(&phase);
        eprintln!(
            "WM static role={:?} phase={:?} surface={flag} tier={tier} baseline={baseline:?} core={core:?}",
            phase.execution_policy.role, phase.phase
        );
        assert!(
            core.0 <= baseline.0,
            "static bytes {baseline:?} -> {core:?}"
        );
        assert!(
            core.1 <= baseline.1,
            "static schemas {baseline:?} -> {core:?}"
        );
        assert!(
            core.2 <= baseline.2,
            "static tokens {baseline:?} -> {core:?}"
        );
    }
}

pub(super) fn assert_static_ratchet(
    turn: &TurnRecord,
    catalog: &butler_turn::btcc::GuidedCatalogSnapshot,
    flag: &str,
    replay: &str,
) {
    check(turn, catalog, flag, replay);
    if turn.context["executionPolicy"]["role"] == "butler"
        && turn.context["executionPolicy"]["accessMode"] == "full_access"
        && turn.context["executionPolicy"]["trackingMode"] == "local"
    {
        for role in ["steward", "worker"] {
            let mut assigned = turn.clone();
            assigned.context["executionPolicy"]["role"] = role.into();
            check(&assigned, catalog, flag, replay);
            assigned.context["executionPolicy"]["subsession"] =
                json!({"executionMode":"mutation","mutationScope":["workspace:/tmp"]});
            check(&assigned, catalog, flag, replay);
        }
    }
}
