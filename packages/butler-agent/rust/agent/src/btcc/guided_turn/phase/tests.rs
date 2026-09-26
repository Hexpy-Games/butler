use serde_json::{Value, json};

use crate::btcc::TurnRecord;

use super::*;

#[test]
fn source_phase_policy_goldens_use_real_registry_definitions() {
    let catalog = GuidedCatalogSnapshot::parse(include_str!("catalog-bun-golden.json")).unwrap();
    let cases: Vec<Value> = serde_json::from_str(include_str!("phase-bun-golden.json")).unwrap();
    assert_eq!(cases.len(), 36);
    for case in cases {
        let turn: TurnRecord = serde_json::from_value(json!({
            "turnId": "turn", "sessionId": "session", "inboxId": "inbox", "triggerKey": "trigger",
            "originalMessageId": "message", "originalMessage": "Inspect and complete the request",
            "modelSelection": {"controls":{"accessMode":case["admittedAccessMode"]}},
            "context": {"userRef":"user", "projectRef":case["projectRef"],
                "projectSources":case["projectSources"], "baselineObservationScopeRefs":case["baselineObservationScopeRefs"],
                "executionPolicy":case["policy"]},
            "semanticState":"admitted", "revision":0, "executionFence":0
        }))
        .unwrap();
        let result = select_phase(GuidedPhaseInput {
            turn: &turn,
            catalog: &catalog,
            phase_surface_flag: if case["enabled"] == true {
                "yes"
            } else {
                "off"
            },
            operation_replay_flag: case["replayFlag"].as_str().unwrap_or(""),
            default_workspace: "/tmp",
        });
        if let Some(error) = case["error"].as_str() {
            let actual = match result.unwrap_err() {
                super::super::work::GuidedPreparationError::Policy(text) => text,
                super::super::work::GuidedPreparationError::Contract(code) => code.into(),
                other => panic!("unexpected error: {other:?}"),
            };
            assert_eq!(actual, error, "case {}", case["index"]);
            continue;
        }
        let result = result.unwrap();
        assert_eq!(result.mode, case["mode"], "case {}", case["index"]);
        assert_eq!(result.phase, case["phase"], "case {}", case["index"]);
        assert_eq!(
            serde_json::to_value(&result.authorized_names).unwrap(),
            case["authorized"],
            "case {}",
            case["index"]
        );
        let names: Vec<_> = result
            .provider_tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            serde_json::to_value(&names).unwrap(),
            case["provider"],
            "case {}",
            case["index"]
        );
        assert_eq!(
            serde_json::to_value(&result.provider_tools).unwrap(),
            case["providerTools"],
            "case {}",
            case["index"]
        );
        assert_eq!(
            result.stable_instruction_prefix, case["instructions"],
            "case {}",
            case["index"]
        );
        assert_eq!(
            result.execution_policy.raw, case["executionPolicy"],
            "case {}",
            case["index"]
        );
        assert_eq!(
            serde_json::to_value(&result.execution_policy.project_id).unwrap(),
            case["executionPolicy"]["projectId"],
            "case {}",
            case["index"]
        );
        assert_eq!(
            result.stable_provider_cache_prefix,
            case.get("stableProviderCachePrefix").cloned(),
            "case {}",
            case["index"]
        );
        assert_eq!(
            result.replay_mode, case["exactResultReplay"]["mode"],
            "case {}",
            case["index"]
        );
    }
}

#[test]
fn image_tool_requires_current_full_access_image_admission() {
    let catalog = GuidedCatalogSnapshot::parse(include_str!("catalog-bun-golden.json")).unwrap();
    for flag in ["on", "off"] {
        let no_image = phase_turn("full_access", json!({}));
        let selection = select_phase(GuidedPhaseInput {
            turn: &no_image,
            catalog: &catalog,
            phase_surface_flag: flag,
            operation_replay_flag: "off",
            default_workspace: "/tmp",
        })
        .unwrap();
        assert!(
            !selection
                .authorized_names
                .contains(&"analyze_attached_image".to_owned())
        );
        assert!(!has_provider_tool(
            &selection.provider_tools,
            "analyze_attached_image"
        ));

        let mut detached_image = image_context();
        detached_image["attachments"] = json!([]);
        let detached_turn = phase_turn("full_access", detached_image);
        let selection = select_phase(GuidedPhaseInput {
            turn: &detached_turn,
            catalog: &catalog,
            phase_surface_flag: flag,
            operation_replay_flag: "off",
            default_workspace: "/tmp",
        })
        .unwrap();
        assert!(
            !selection
                .authorized_names
                .contains(&"analyze_attached_image".to_owned())
        );
        assert!(!has_provider_tool(
            &selection.provider_tools,
            "analyze_attached_image"
        ));

        let mut with_image = phase_turn("full_access", image_context());
        // Host validates the frozen Models admission and supplies this Turn fact.
        with_image.context["executionPolicy"]["requiredNativeTools"] =
            json!(["analyze_attached_image"]);
        let selection = select_phase(GuidedPhaseInput {
            turn: &with_image,
            catalog: &catalog,
            phase_surface_flag: flag,
            operation_replay_flag: "off",
            default_workspace: "/tmp",
        })
        .unwrap();
        assert!(
            selection
                .authorized_names
                .contains(&"analyze_attached_image".to_owned())
        );
        assert!(has_provider_tool(
            &selection.provider_tools,
            "analyze_attached_image"
        ));
    }

    let mut stale = image_context();
    stale["imageAdmission"]["capability"]["routeHealth"] = json!("transient_failure");
    let stale_turn = phase_turn("full_access", stale);
    let selection = select_phase(GuidedPhaseInput {
        turn: &stale_turn,
        catalog: &catalog,
        phase_surface_flag: "on",
        operation_replay_flag: "off",
        default_workspace: "/tmp",
    })
    .unwrap();
    assert!(
        !selection
            .authorized_names
            .contains(&"analyze_attached_image".to_owned())
    );
    assert!(!has_provider_tool(
        &selection.provider_tools,
        "analyze_attached_image"
    ));

    // Host never supplies the image capability fact to a read-only Turn.
    let read_only = phase_turn("read_only", image_context());
    let selection = select_phase(GuidedPhaseInput {
        turn: &read_only,
        catalog: &catalog,
        phase_surface_flag: "on",
        operation_replay_flag: "off",
        default_workspace: "/tmp",
    })
    .unwrap();
    assert!(
        !selection
            .authorized_names
            .contains(&"analyze_attached_image".to_owned())
    );
    assert!(!has_provider_tool(
        &selection.provider_tools,
        "analyze_attached_image"
    ));
}

fn has_provider_tool(tools: &[Value], expected: &str) -> bool {
    tools
        .iter()
        .any(|tool| tool.get("name").and_then(Value::as_str) == Some(expected))
}

fn phase_turn(access_mode: &str, context_bits: Value) -> TurnRecord {
    let mut context = json!({
        "userRef":"user",
        "executionPolicy":{
            "role":"butler",
            "accessMode":access_mode,
            "trackingMode":"none",
            "requiredNativeToolProfiles":[],
            "requiredNativeTools":[],
            "workspacePath":"/tmp"
        }
    });
    if let Some(object) = context_bits.as_object() {
        for (key, value) in object {
            context[key] = value.clone();
        }
    }
    serde_json::from_value(json!({
        "turnId":"turn",
        "sessionId":"session",
        "inboxId":"inbox",
        "triggerKey":"trigger",
        "originalMessageId":"message",
        "originalMessage":"Analyze the attached image.",
        "modelSelection":{"controls":{"accessMode":access_mode}},
        "context":context,
        "semanticState":"admitted",
        "revision":0,
        "executionFence":0
    }))
    .unwrap()
}

fn image_context() -> Value {
    let digest = "d".repeat(64);
    let source_digest = "s".repeat(64);
    let derivative_digest = "e".repeat(64);
    let manifest_digest = "f".repeat(64);
    json!({
        "attachments":[{"id":"file-current","kind":"image"}],
        "imageAdmission":{
            "tuple":{
                "providerId":"zai",
                "modelId":"glm-5.2",
                "carrierProtocol":"zai_mcp_vision",
                "endpointProfileId":"profile",
                "catalogCapabilityRevision":"revision",
                "catalogCapabilityDigest":digest
            },
            "capability":{
                "providerId":"zai",
                "modelId":"glm-5.2",
                "carrierProtocol":"zai_mcp_vision",
                "endpointProfileId":"profile",
                "catalogCapabilityRevision":"revision",
                "catalogCapabilityDigest":digest,
                "modelSupport":"supported",
                "capabilitySource":"provider_discovery",
                "routeHealth":"healthy",
                "inputModalities":["image"],
                "acceptedMimeTypes":["image/png"],
                "maxInlineImageBytes":1024,
                "maxWidth":100,
                "maxHeight":100,
                "maxPixels":10000,
                "sourceUrl":"https://example.test",
                "verifiedAt":"2026-09-24T00:00:00Z",
                "evidenceRevision":"revision",
                "evidenceDigest":digest,
                "toolServerId":"zai-vision",
                "toolName":"analyze_image",
                "toolCapabilityDigest":digest
            },
            "manifests":[{
                "kind":"image",
                "fileId":"file-current",
                "position":0,
                "safeName":"image.png",
                "mimeType":"image/png",
                "sniffedMimeType":"image/png",
                "sniffedMagic":"png",
                "storageRevision":"message-file-row-v1",
                "sourceSizeBytes":10,
                "sourceDigest":source_digest,
                "derivativeId":"file-current:visual:test",
                "derivativeMimeType":"image/png",
                "derivativeSizeBytes":5,
                "derivativeDigest":derivative_digest,
                "width":1,
                "height":1,
                "pixelCount":1,
                "sanitizerRevision":"test",
                "manifestDigest":manifest_digest
            }]
        }
    })
}
