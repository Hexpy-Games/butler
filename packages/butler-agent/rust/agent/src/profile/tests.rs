use std::collections::HashMap;
use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::json;

use super::contracts::ProfileCandidateInput;
use super::*;

mod extraction;
mod legacy_candidates;
mod provider;
mod support;

use support::{Root, service};

#[tokio::test]
async fn naming_and_extractor_mutations_reread_external_files() {
    let root = Root::new("naming");
    let (service, _) = service(&root, HashMap::new());
    let updated = service
        .update_personalization_profile(PersonalizationProfileUpdate {
            principal_name: Some("  Ada\r\nLovelace  ".into()),
            preferred_address: Some("Ada".into()),
            butler_nickname: None,
        })
        .await
        .unwrap();
    assert_eq!(updated.principal_name, "Ada\nLovelace");
    assert_eq!(
        service.read_personalization_profile().await.unwrap(),
        updated
    );
    let rendered = crate::profile::naming::render(&updated).unwrap();
    assert!(rendered.contains("Principal name: Ada\nLovelace"));
    fs::write(
        root.0.join("butler.config.json"),
        r#"{"system":{"butlerModel":"openai/gpt-5.5"},"keep":true}"#,
    )
    .unwrap();
    let configured = service
        .set_extractor_model(Some("anthropic/claude-sonnet-4-5".into()))
        .await
        .unwrap();
    assert_eq!(
        configured.configured_model.as_deref(),
        Some("anthropic/claude-sonnet-4-5")
    );
    let saved: serde_json::Value =
        serde_json::from_slice(&fs::read(root.0.join("butler.config.json")).unwrap()).unwrap();
    assert_eq!(saved["keep"], true);
}

#[tokio::test]
async fn extractor_model_uses_nullish_but_not_invalid_butler_model_fallback() {
    let root = Root::new("extractor-model-nullish");
    let (service, _) = service(&root, HashMap::new());
    fs::write(
        root.0.join("butler.config.json"),
        r#"{"system":{"butlerModel":null,"defaultModel":"openai/gpt-5.5"}}"#,
    )
    .unwrap();
    assert_eq!(
        service
            .read_extractor_model()
            .await
            .unwrap()
            .effective_model,
        "openai/gpt-5.5"
    );

    fs::write(
        root.0.join("butler.config.json"),
        r#"{"system":{"butlerModel":"","defaultModel":"openai/gpt-5.5"}}"#,
    )
    .unwrap();
    assert_eq!(
        service
            .read_extractor_model()
            .await
            .unwrap()
            .effective_model,
        crate::models::DEFAULT_MODEL_REF
    );
}

#[tokio::test]
async fn onboarding_prompt_completion_and_consent_last_state_are_durable() {
    let root = Root::new("onboarding");
    let (service, _) = service(&root, HashMap::new());
    let golden: serde_json::Value =
        serde_json::from_str(include_str!("tests/bun-onboarding-golden.json")).unwrap();
    let prompt = service
        .render_first_chat_onboarding("en")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(prompt, golden["prompt"]);
    let result = service
        .update_first_chat_onboarding(FirstChatOnboardingUpdate {
            principal_name: Some("Grace".into()),
            preferred_address: Some("Grace".into()),
            profiling_mode: Some(ProfilingMode::Basic),
            skipped_fields: vec!["interests".into()],
            complete: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(result.status, "complete");
    assert_eq!(serde_json::to_value(&result).unwrap(), golden["result"]);
    assert_eq!(result.profiling.mode, ProfilingMode::Basic);
    assert_eq!(result.profiling.captured_candidate_count, 0);
    assert!(
        service
            .render_first_chat_onboarding("en")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        service.read_profiling_consent().await.unwrap().mode,
        ProfilingMode::Basic
    );
}

#[tokio::test]
async fn off_reenable_and_clear_preserve_consent_but_remove_source_rows() {
    let root = Root::new("clear");
    let (service, _) = service(&root, HashMap::new());
    service
        .set_profiling_mode(ProfilingMode::Deep)
        .await
        .unwrap();
    let db = storage::open(&root.0, true).unwrap();
    db.execute("INSERT INTO profile_candidates(id,category,payload_json,source_type,confidence,sensitive_domain,created_at,updated_at,last_seen_at,status)VALUES('c','communication','{\"summary\":\"Concise\"}','explicit','high',0,'t','t','t','candidate')",[]).unwrap();
    db.execute("INSERT INTO profile_source_coverage(coverage_key,message_id,source_hash,part_id,part_index,scalar_pointer,byte_start,byte_end,extractor_version,observed_at,evidence_ref,disposition,updated_at)VALUES('k','m','h','p',0,'/text',0,1,'v','t','e','complete','t')",[]).unwrap();
    drop(db);
    service
        .set_profiling_mode(ProfilingMode::Off)
        .await
        .unwrap();
    service
        .set_profiling_mode(ProfilingMode::Basic)
        .await
        .unwrap();
    let db = storage::open(&root.0, false).unwrap();
    let retained_candidates: i64 = db
        .query_row("SELECT COUNT(*) FROM profile_candidates", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(retained_candidates, 1);
    drop(db);
    let cleared = service.clear_profiling_data().await.unwrap();
    assert_eq!(cleared.removed_candidates, 1);
    assert_eq!(
        service.read_profiling_consent().await.unwrap().mode,
        ProfilingMode::Basic
    );
}

#[tokio::test]
async fn generated_projection_requires_current_canonical_evidence_and_closes_reader() {
    let root = Root::new("projection");
    let message = CanonicalProfileMessage {
        id: "m".into(),
        session_id: "s".into(),
        role: "user".into(),
        origin_kind: "user_input".into(),
        created_at: "2023-11-14T22:13:20.000Z".into(),
        parts: vec![CanonicalProfilePart {
            part_id: "p".into(),
            part_index: 0.0,
            scalars: vec![CanonicalProfileScalar {
                pointer: "/text".into(),
                source_hash: "h".into(),
                text: "hello".into(),
            }],
        }],
    };
    let (service, closed) = service(&root, HashMap::from([("m".into(), message)]));
    service
        .set_profiling_mode(ProfilingMode::Basic)
        .await
        .unwrap();
    let db = storage::open(&root.0, true).unwrap();
    db.execute("INSERT INTO profile_source_coverage(coverage_key,message_id,source_hash,part_id,part_index,scalar_pointer,byte_start,byte_end,extractor_version,observed_at,evidence_ref,disposition,updated_at)VALUES('k','m','h','p',0,'/text',0,5,'v','2023-11-14T22:13:20.000Z','e','complete','t')",[]).unwrap();
    drop(db);
    candidates::upsert(
        &root.0,
        ProfileCandidateInput {
            category: "communication".into(),
            payload: json!({"summary":"Use concise answers","butler_should":["Be concise"]}),
            source_type: "explicit".into(),
            confidence: "high".into(),
            sensitive_domain: false,
            evidence_ref: Some("e".into()),
            evidence_observed_at: Some("2023-11-14T22:13:20.000Z".into()),
            expires_or_decay: Some("decay".into()),
        },
        "2023-11-14T22:13:20.000Z",
    )
    .unwrap();
    let result = service.consolidate_profile_candidates().await.unwrap();
    assert_eq!(result.promoted_count, 1);
    assert!(result.projection_written);
    let current = service
        .read_runtime_profile_projection()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        current.how_to_answer,
        vec!["Be concise", "Use concise answers"]
    );
    assert_eq!(closed.load(Ordering::SeqCst), 2);
    let reflected = service.reflective_summary("en").await.unwrap();
    assert_eq!(reflected.entry_count, 1);
    assert!(reflected.summary.contains("working interpretation"));
}

#[tokio::test]
async fn candidate_duplicate_and_promoted_stable_merge_preserve_source_history() {
    let root = Root::new("candidate-merge");
    let (service, _) = service(&root, HashMap::new());
    service
        .set_profiling_mode(ProfilingMode::Deep)
        .await
        .unwrap();
    let candidate = |evidence: &str, instruction: &str| ProfileCandidateInput {
        category: "cares".into(),
        payload: json!({
            "facet":"current_interests",
            "summary":"Rust migration",
            "butler_should":[instruction],
            "sensitivity":"restricted"
        }),
        source_type: "explicit".into(),
        confidence: "medium".into(),
        sensitive_domain: true,
        evidence_ref: Some(evidence.into()),
        evidence_observed_at: Some("2023-11-14T22:13:20.000Z".into()),
        expires_or_decay: Some("decay".into()),
    };
    let first = candidates::upsert(
        &root.0,
        candidate("e1", "Prefer native ownership"),
        "2023-11-14T22:13:20.000Z",
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        serde_json::to_value(first).unwrap(),
        json!({
            "id":"pc_6669536ca6f6f7df","layer":"current_attention","category":"cares",
            "facet":"current_interests","summary":"Rust migration",
            "applies_when":["topic_relevance"],
            "butler_should":["Prefer native ownership","use this as current context only when relevant"],
            "butler_should_not":["overfit unrelated answers to this interest"],
            "temporal_scope":"active","decay_policy":"days_30","contradiction_refs":[],
            "sensitivity":"normal","evidence_refs":["e1"],
            "evidence_observed_at":{"e1":"2023-11-14T22:13:20.000Z"},"evidence_count":1,
            "source_type":"explicit","confidence":"medium","sensitive_domain":false,
            "status":"candidate","created_at":"2023-11-14T22:13:20.000Z",
            "updated_at":"2023-11-14T22:13:20.000Z","last_seen_at":"2023-11-14T22:13:20.000Z",
            "expires_or_decay":"decay","promoted_at":null
        })
    );
    candidates::upsert(
        &root.0,
        candidate("e1", "Keep durable evidence"),
        "2023-11-15T22:13:20.000Z",
    )
    .unwrap();
    let db = storage::open(&root.0, false).unwrap();
    let (updated_at, sensitive_domain, payload_json): (String, i64, String) = db
        .query_row(
            "SELECT updated_at,sensitive_domain,payload_json FROM profile_candidates ORDER BY id LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    let duplicate: serde_json::Value = serde_json::from_str(&payload_json).unwrap();
    assert_eq!(updated_at, "2023-11-14T22:13:20.000Z");
    assert_eq!(duplicate["evidence_count"], 1);
    assert_eq!(sensitive_domain, 0);
    assert_eq!(duplicate["sensitivity"], "normal");
    drop(db);

    let consolidated = service.consolidate_profile_candidates().await.unwrap();
    assert_eq!(consolidated.promoted_count, 1);
    assert!(!consolidated.projection_written);
    assert!(
        service
            .read_runtime_profile_projection()
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        service.reflective_summary("en").await.unwrap().entry_count,
        1
    );
    candidates::upsert(
        &root.0,
        candidate("e2", "Retain merged instructions"),
        "2023-11-16T22:13:20.000Z",
    )
    .unwrap();
    let stable = storage::stable_entries(&root.0).unwrap();
    assert_eq!(stable.len(), 1);
    assert_eq!(stable[0].payload["evidence_refs"], json!(["e1", "e2"]));
    let instructions = stable[0].payload["butler_should"].as_array().unwrap();
    assert!(
        instructions
            .iter()
            .any(|value| value == "Keep durable evidence")
    );
    assert!(
        instructions
            .iter()
            .any(|value| value == "Retain merged instructions")
    );
}

#[tokio::test]
async fn dropped_caller_keeps_registered_blocking_operation_owned_until_close_drain() {
    let root = Root::new("lifecycle");
    let (service, _) = service(&root, HashMap::new());
    let started = Arc::new(AtomicBool::new(false));
    let release = Arc::new(AtomicBool::new(false));
    let worker = {
        let service = service.clone();
        let started = started.clone();
        let release = release.clone();
        tokio::spawn(async move {
            service
                .run(move || {
                    started.store(true, Ordering::SeqCst);
                    while !release.load(Ordering::SeqCst) {
                        std::thread::yield_now();
                    }
                    Ok(())
                })
                .await
        })
    };
    while !started.load(Ordering::SeqCst) {
        tokio::task::yield_now().await;
    }
    worker.abort();
    let close = {
        let service = service.clone();
        tokio::spawn(async move { service.close().await })
    };
    tokio::task::yield_now().await;
    assert!(!close.is_finished());
    release.store(true, Ordering::SeqCst);
    close.await.unwrap();
    assert_eq!(
        service
            .read_personalization_profile()
            .await
            .unwrap_err()
            .code,
        "profile_closed"
    );
}
