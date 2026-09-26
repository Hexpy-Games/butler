use std::sync::Arc;

use serde_json::{Value, json};

use super::*;
use crate::btcc::{GuidedPhaseInput, TurnRecord, select_phase};
use crate::workspace::{NativeWorkspaceFiles, WorkspaceMutations};

fn catalog() -> NativeGuidedCatalog {
    let capabilities = NativeCapabilities::new(
        Arc::new(NativeWorkspaceFiles::new(1)),
        Arc::new(WorkspaceMutations::new()),
    );
    NativeGuidedCatalog::load(&capabilities).unwrap()
}

/// (admitted access, turn context, phase surface enabled, replay flag,
/// Ok((mode, phase, write_file authorized, work tools authorized)) | Err(policy error))
type PhaseCase = (
    &'static str,
    &'static str,
    bool,
    &'static str,
    Result<(&'static str, &'static str, bool, bool), &'static str>,
);

#[test]
fn phase_selection_enforces_execution_policy_access_and_required_tools() {
    let catalog = catalog();
    let cases: [PhaseCase; 13] = [
        (
            "full_access",
            r#"{"projectSources":[{"title":"source"}],"baselineObservationScopeRefs":[],"executionPolicy":{"role":"butler","accessMode":"full_access","trackingMode":"local","requiredNativeToolProfiles":[],"requiredNativeTools":[],"workspacePath":"/tmp"}}"#,
            false,
            "",
            Ok(("legacy", "execution", true, true)),
        ),
        (
            "full_access",
            r#"{"projectSources":[{"title":"source"}],"baselineObservationScopeRefs":[],"executionPolicy":{"role":"butler","accessMode":"full_access","trackingMode":"local","requiredNativeToolProfiles":[],"requiredNativeTools":[],"workspacePath":"/tmp"}}"#,
            true,
            "",
            Ok(("phase_minimal", "execution", true, true)),
        ),
        (
            "full_access",
            r#"{"projectSources":[],"baselineObservationScopeRefs":[],"executionPolicy":{"role":"butler","accessMode":"read_only","trackingMode":"none","requiredNativeToolProfiles":[],"requiredNativeTools":[],"workspacePath":"/tmp"}}"#,
            true,
            " YES ",
            Ok(("phase_minimal", "direct", false, false)),
        ),
        (
            "full_access",
            r#"{"projectRef":"project","projectSources":[],"baselineObservationScopeRefs":[],"executionPolicy":{"role":"butler","accessMode":"read_only","trackingMode":"ledger","requiredNativeToolProfiles":["project"],"requiredNativeTools":[],"workspacePath":"/tmp","projectId":"project"}}"#,
            true,
            "",
            Ok(("phase_minimal", "execution", false, true)),
        ),
        (
            "read_only",
            r#"{"projectSources":[],"baselineObservationScopeRefs":["workspace:/tmp"],"executionPolicy":null}"#,
            true,
            "",
            Ok(("phase_minimal", "execution", false, true)),
        ),
        (
            "full_access",
            r#"{"projectSources":[],"baselineObservationScopeRefs":[],"executionPolicy":{"role":"butler","accessMode":"full_access","trackingMode":"none","requiredNativeToolProfiles":["unknown-profile"],"requiredNativeTools":[],"workspacePath":"/tmp"}}"#,
            true,
            "",
            Err("unknown required tool profile: unknown-profile"),
        ),
        (
            "full_access",
            r#"{"projectSources":[],"baselineObservationScopeRefs":[],"executionPolicy":{"role":"steward","accessMode":"read_only","trackingMode":"none","requiredNativeToolProfiles":[],"requiredNativeTools":["write_file"],"workspacePath":"/tmp"}}"#,
            false,
            "",
            Ok(("legacy", "read_only", true, false)),
        ),
        (
            "full_access",
            r#"{"projectSources":[],"baselineObservationScopeRefs":[],"executionPolicy":{"role":"steward","accessMode":"read_only","trackingMode":"none","requiredNativeToolProfiles":[],"requiredNativeTools":["write_file"],"workspacePath":"/tmp"}}"#,
            true,
            "",
            Err("required tool is ineligible for read_only phase: write_file"),
        ),
        (
            "full_access",
            r#"{"projectSources":[],"baselineObservationScopeRefs":[],"executionPolicy":{"role":"worker","accessMode":"read_only","trackingMode":"none","requiredNativeToolProfiles":["workspace"],"requiredNativeTools":[],"workspacePath":"/tmp"}}"#,
            true,
            "",
            Err("required tool profile is ineligible for read_only phase: workspace"),
        ),
        (
            "ask_first",
            r#"{"projectSources":[],"baselineObservationScopeRefs":[],"executionPolicy":{"role":"butler","accessMode":"full_access","trackingMode":"ledger","requiredNativeToolProfiles":[],"requiredNativeTools":[],"workspacePath":"/tmp","projectId":"project"}}"#,
            true,
            "",
            Ok(("phase_minimal", "execution", true, true)),
        ),
        (
            "full_access",
            r#"{"projectSources":[],"baselineObservationScopeRefs":[],"executionPolicy":{"role":"steward","accessMode":"read_only","trackingMode":"none","requiredNativeToolProfiles":[],"requiredNativeTools":[],"workspacePath":"/tmp","projectId":""}}"#,
            true,
            "",
            Ok(("phase_minimal", "direct", false, false)),
        ),
        (
            "full_access",
            r#"{"projectRef":"project","projectSources":[],"baselineObservationScopeRefs":[],"executionPolicy":{"role":"steward","accessMode":"read_only","trackingMode":"none","requiredNativeToolProfiles":[],"requiredNativeTools":[],"workspacePath":"/tmp","projectId":""}}"#,
            true,
            "",
            Ok(("phase_minimal", "read_only", false, false)),
        ),
        (
            "full_access",
            r#"{"projectRef":"","projectSources":[],"baselineObservationScopeRefs":["workspace:/tmp"],"executionPolicy":null}"#,
            true,
            "",
            Ok(("phase_minimal", "execution", true, true)),
        ),
    ];
    for (admitted, context, enabled, replay, expected) in cases {
        let context: Value = serde_json::from_str(context).unwrap();
        let turn: TurnRecord = serde_json::from_value(json!({
            "turnId":"turn", "sessionId":"session", "inboxId":"inbox", "triggerKey":"trigger",
            "originalMessageId":"message", "originalMessage":"Inspect and complete the request",
            "modelSelection":{"controls":{"accessMode":admitted}},
            "context":{"userRef":"user"},
            "semanticState":"admitted", "revision":0, "executionFence":0
        }))
        .map(|mut turn: TurnRecord| {
            for (key, value) in context.as_object().unwrap() {
                turn.context[key] = value.clone();
            }
            turn
        })
        .unwrap();
        let selection = select_phase(GuidedPhaseInput {
            turn: &turn,
            catalog: catalog.snapshot(),
            phase_surface_flag: if enabled { "yes" } else { "off" },
            operation_replay_flag: replay,
            default_workspace: "/tmp",
        });
        match expected {
            Err(message) => {
                let error = selection.unwrap_err();
                assert!(
                    format!("{error:?}").contains(message),
                    "{context}: {error:?}"
                );
            }
            Ok((mode, phase, writes, work)) => {
                let selection = selection.unwrap();
                assert_eq!(
                    (selection.mode, selection.phase),
                    (mode, phase),
                    "{context}"
                );
                let authorized =
                    |name: &str| selection.authorized_names.iter().any(|tool| tool == name);
                assert_eq!(authorized("write_file"), writes, "{context}");
                assert_eq!(authorized("start_work"), work, "{context}");
            }
        }
    }
}

#[test]
fn image_tool_requires_current_full_access_image_admission() {
    let catalog = catalog();
    let catalog = catalog.snapshot();
    for flag in ["on", "off"] {
        let no_image = phase_turn("full_access", &json!({}));
        let selection = select_phase(GuidedPhaseInput {
            turn: &no_image,
            catalog,
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
        let detached_turn = phase_turn("full_access", &detached_image);
        let selection = select_phase(GuidedPhaseInput {
            turn: &detached_turn,
            catalog,
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

        let mut with_image = phase_turn("full_access", &image_context());
        // Host validates the frozen Models admission and supplies this Turn fact.
        with_image.context["executionPolicy"]["requiredNativeTools"] =
            json!(["analyze_attached_image"]);
        let selection = select_phase(GuidedPhaseInput {
            turn: &with_image,
            catalog,
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
    let stale_turn = phase_turn("full_access", &stale);
    let selection = select_phase(GuidedPhaseInput {
        turn: &stale_turn,
        catalog,
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
    let read_only = phase_turn("read_only", &image_context());
    let selection = select_phase(GuidedPhaseInput {
        turn: &read_only,
        catalog,
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

fn phase_turn(access_mode: &str, context_bits: &Value) -> TurnRecord {
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
