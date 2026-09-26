use std::sync::Arc;

use serde_json::{Value, json};

use super::*;
use crate::btcc::{GuidedPhaseInput, TurnRecord, select_phase};
use crate::workspace::{NativeWorkspaceFiles, WorkspaceMutations};

#[test]
fn real_catalog_preserves_source_phase_selection_without_claiming_executors() {
    let capabilities = NativeCapabilities::new(
        Arc::new(NativeWorkspaceFiles::new(1)),
        Arc::new(WorkspaceMutations::new()),
    );
    let catalog = NativeGuidedCatalog::load(&capabilities).unwrap();
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../btcc/guided_turn/phase/phase-bun-golden.json"
    ))
    .unwrap();
    assert_eq!(cases.len(), 36);
    let mut accepted = 0;
    for case in cases {
        let turn: TurnRecord = serde_json::from_value(json!({
            "turnId":"turn", "sessionId":"session", "inboxId":"inbox", "triggerKey":"trigger",
            "originalMessageId":"message", "originalMessage":"Inspect and complete the request",
            "modelSelection":{"controls":{"accessMode":case["admittedAccessMode"]}},
            "context":{"userRef":"user", "projectRef":case["projectRef"],
                "projectSources":case["projectSources"],
                "baselineObservationScopeRefs":case["baselineObservationScopeRefs"],
                "executionPolicy":case["policy"]},
            "semanticState":"admitted", "revision":0, "executionFence":0
        }))
        .unwrap();
        let selection = select_phase(GuidedPhaseInput {
            turn: &turn,
            catalog: catalog.snapshot(),
            phase_surface_flag: if case["enabled"] == true {
                "yes"
            } else {
                "off"
            },
            operation_replay_flag: case["replayFlag"].as_str().unwrap_or(""),
            default_workspace: "/tmp",
        });
        if case.get("error").is_some() {
            assert!(selection.is_err());
            continue;
        }
        let selection = selection.unwrap();
        accepted += 1;
        assert_eq!(json!(selection.authorized_names), case["authorized"]);
        assert_eq!(json!(selection.provider_tools), case["providerTools"]);
    }
    assert!(accepted > 20);
}
