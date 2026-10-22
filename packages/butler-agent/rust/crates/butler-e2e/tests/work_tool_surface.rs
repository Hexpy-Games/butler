//! Format pins against origin/main before the Work tool replacement.
#![allow(clippy::unwrap_used, reason = "format-pin assertions")]
use butler_turn::btcc::{GuidedCatalogSnapshot, GuidedPhaseInput, TurnRecord, select_phase};
use serde_json::{Value, json};
fn turn(phase: &str) -> TurnRecord {
    let (tracking, profiles, access) = match phase {
        "direct" | "read_only" => ("none", json!([]), "read_only"),
        "untracked_execution" => ("none", json!(["workspace"]), "full_access"),
        _ => ("local", json!([]), "full_access"),
    };
    serde_json::from_value(json!({"turnId":"turn","sessionId":"session","inboxId":"inbox","triggerKey":"trigger",
        "originalMessageId":"message","originalMessage":"Request","modelSelection":{"provider":"openai","model":"gpt","reasoningEffort":"medium","controls":{"accessMode":access},"controlsHash":"hash"},
        "context":{"executionPolicy":{"role":"butler","accessMode":access,"trackingMode":tracking,"projectId":if phase=="read_only" {json!("project")} else {Value::Null},"requiredNativeToolProfiles":profiles,"requiredNativeTools":[],"workspacePath":"/tmp"}},
        "semanticState":"admitted","revision":0,"executionFence":0})).unwrap()
}
fn measurements(source: &str) -> Value {
    let catalog = GuidedCatalogSnapshot::parse(source).unwrap();
    let mut values = json!({});
    for phase in ["direct", "read_only", "execution", "untracked_execution"] {
        let turn = turn(phase);
        let selected = select_phase(GuidedPhaseInput {
            turn: &turn,
            catalog: &catalog,
            phase_surface_flag: "on",
            operation_replay_flag: "off",
            default_workspace: "/tmp",
        })
        .unwrap();
        let mut names: Vec<_> = selected
            .provider_tools
            .iter()
            .map(|v| v["name"].as_str().unwrap().to_owned())
            .collect();
        names.sort();
        let prefix = selected.stable_instruction_prefix;
        if phase == "untracked_execution" {
            assert!(!prefix.contains("work_apply"));
            assert!(
                !names
                    .iter()
                    .any(|n| matches!(n.as_str(), "work_read" | "work_apply" | "session_control"))
            );
        }
        let text = prefix.clone() + &serde_json::to_string(&selected.provider_tools).unwrap();
        let tokens = tiktoken_rs::o200k_base_singleton()
            .encode_ordinary(&text)
            .len();
        values[phase] = json!({"names":names,"count":names.len(),"static_tokens":tokens,"static_bytes":prefix.len()+serde_json::to_vec(&selected.provider_tools).unwrap().len()});
    }
    values
}
// test-category: format-pin
#[test]
fn main_phase_baseline() -> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let old: Value = serde_json::from_str(include_str!(
        "../fixtures/work-model-p14/work-tools-main.json"
    ))?;
    let source = butler_core::tool_catalog::load()?;
    let new = measurements(&source.to_string());
    eprintln!("static surfaces: {new}");
    for phase in ["direct", "read_only"] {
        assert_eq!(old[phase], new[phase], "{phase}");
    }
    let untracked: Vec<_> = old["untracked_execution"]["names"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|name| *name != "update_todo_list")
        .cloned()
        .collect();
    assert_eq!(new["untracked_execution"]["names"], json!(untracked));
    for metric in ["static_bytes", "static_tokens"] {
        assert!(
            new["untracked_execution"][metric].as_u64().unwrap()
                <= old["untracked_execution"][metric].as_u64().unwrap()
        );
    }
    assert!(
        new["execution"]["count"].as_u64().unwrap() < old["execution"]["count"].as_u64().unwrap()
    );
    assert!(
        new["execution"]["static_bytes"].as_u64().unwrap()
            <= old["execution"]["static_bytes"].as_u64().unwrap()
    );
    assert!(
        new["execution"]["static_tokens"].as_u64().unwrap()
            <= old["execution"]["static_tokens"].as_u64().unwrap()
    );
    Ok(())
}

// test-category: format-pin
#[test]
fn delegated_prompts_preserve_role_and_scope() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let expected: Value = serde_json::from_str(include_str!("../fixtures/work-model-p14/child-prompts.json"))?;
    let catalog = GuidedCatalogSnapshot::parse(&butler_core::tool_catalog::load()?.to_string())?;
    for role in ["steward", "worker"] {
        let mut turn = turn("execution");
        turn.context["executionPolicy"]["role"] = json!(role);
        turn.context["executionPolicy"]["subsession"] = json!({"rootSessionId":"parent", "executionMode":"mutation", "mutationScope":["assigned files"]});
        let selected = select_phase(GuidedPhaseInput {
            turn: &turn, catalog: &catalog, phase_surface_flag: "on",
            operation_replay_flag: "off", default_workspace: "/tmp",
        })?;
        assert_eq!(selected.stable_instruction_prefix, expected[role].as_str().unwrap(), "{role}");
    }
    Ok(())
}

