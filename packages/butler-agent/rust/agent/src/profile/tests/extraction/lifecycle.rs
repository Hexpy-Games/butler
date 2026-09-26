use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};
use tokio::sync::Notify;

use super::super::support::{Root, service_with_parts};
use super::super::*;
use crate::btcc::ModelRoundError;
use crate::models::{
    ProviderPromptFuture, ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest,
    ProviderPromptResult,
};

fn message(text: &str) -> CanonicalProfileMessage {
    CanonicalProfileMessage {
        id: "m1".into(),
        session_id: "s1".into(),
        role: "user".into(),
        origin_kind: "user_input".into(),
        created_at: "2023-11-14T22:13:20.000Z".into(),
        parts: vec![CanonicalProfilePart {
            part_id: "p1".into(),
            part_index: 0.0,
            scalars: vec![CanonicalProfileScalar {
                pointer: "/text".into(),
                source_hash: format!("{:x}", Sha256::digest(text.as_bytes())),
                text: text.into(),
            }],
        }],
    }
}

struct FailingProvider;
impl ProviderPromptPort for FailingProvider {
    fn run_prompt<'a>(
        &'a self,
        _request: ProviderPromptRequest<'a>,
        _lifecycle: ProviderPromptLifecycle<'a>,
    ) -> ProviderPromptFuture<'a> {
        Box::pin(async { Err(ModelRoundError::StablePrefix("test_failure".into())) })
    }
}

struct CountingProvider(Arc<AtomicUsize>);
impl ProviderPromptPort for CountingProvider {
    fn run_prompt<'a>(
        &'a self,
        _request: ProviderPromptRequest<'a>,
        _lifecycle: ProviderPromptLifecycle<'a>,
    ) -> ProviderPromptFuture<'a> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err(ModelRoundError::StablePrefix("unexpected".into())) })
    }
}

#[tokio::test]
async fn already_cancelled_request_never_enters_provider() {
    let root = Root::new("pre-cancelled-provider");
    let calls = Arc::new(AtomicUsize::new(0));
    let messages = Arc::new(Mutex::new(HashMap::from([(
        "m1".into(),
        message("Please stay concise"),
    )])));
    let (service, _) =
        service_with_parts(&root, messages, Arc::new(CountingProvider(calls.clone())));
    service
        .set_profiling_mode(ProfilingMode::Basic)
        .await
        .unwrap();
    let cancellation = tokio_util::sync::CancellationToken::new();
    cancellation.cancel();
    let _result = service
        .capture_profile_candidates_from_transcripts_with_model(
            ProfileModelTranscriptCaptureOptions {
                cancellation,
                ..Default::default()
            },
        )
        .await;
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    service.close().await;
}

#[tokio::test]
async fn provider_failure_marks_claim_failed_and_clears_owner() {
    let root = Root::new("provider-failure");
    let messages = Arc::new(Mutex::new(HashMap::from([(
        "m1".into(),
        message("Please stay concise"),
    )])));
    let (service, _) = service_with_parts(&root, messages, Arc::new(FailingProvider));
    service
        .set_profiling_mode(ProfilingMode::Basic)
        .await
        .unwrap();
    let result = service
        .capture_profile_candidates_from_transcripts_with_model(Default::default())
        .await
        .unwrap();
    assert_eq!(result.coverage_failed_count, Some(1));
    assert_eq!(
        result.model_error.as_deref(),
        Some("profile extractor response failed validation")
    );
    let db = storage::open(&root.0, false).unwrap();
    let owner: (String, Option<f64>, Option<String>) = db
        .query_row(
            "SELECT disposition,owner_pid,owner_nonce FROM profile_source_coverage",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(owner, ("failed".into(), None, None));
    service.close().await;
}

struct MutatingProvider {
    messages: Arc<Mutex<HashMap<String, CanonicalProfileMessage>>>,
}
impl ProviderPromptPort for MutatingProvider {
    fn run_prompt<'a>(
        &'a self,
        request: ProviderPromptRequest<'a>,
        _lifecycle: ProviderPromptLifecycle<'a>,
    ) -> ProviderPromptFuture<'a> {
        let messages = self.messages.clone();
        let prompt = request.prompt.to_owned();
        Box::pin(async move {
            let prompt: serde_json::Value = serde_json::from_str(&prompt).unwrap();
            let reference = prompt["observations"][0]["ref"].as_str().unwrap();
            messages.lock().unwrap().get_mut("m1").unwrap().parts[0].scalars[0].text =
                "Changed after inference".into();
            Ok(ProviderPromptResult {
                text: serde_json::json!({"candidates":[{
                    "category":"communication","summary":"Concise responses",
                    "source_type":"explicit","confidence":"high",
                    "evidence_refs":[reference],"sensitive_domain":false
                }]})
                .to_string(),
                model: "openai/test".into(),
                usage: None,
            })
        })
    }
}

#[tokio::test]
async fn source_mutation_interrupts_commit_without_failed_receipt() {
    let root = Root::new("source-mutation");
    let messages = Arc::new(Mutex::new(HashMap::from([(
        "m1".into(),
        message("Please stay concise"),
    )])));
    let (service, _) = service_with_parts(
        &root,
        messages.clone(),
        Arc::new(MutatingProvider { messages }),
    );
    service
        .set_profiling_mode(ProfilingMode::Basic)
        .await
        .unwrap();
    let result = service
        .capture_profile_candidates_from_transcripts_with_model(Default::default())
        .await
        .unwrap();
    assert_eq!(
        result.model_error.as_deref(),
        Some("profile source changed")
    );
    assert_eq!(result.coverage_pending_count, Some(1));
    let db = storage::open(&root.0, false).unwrap();
    let owner: (String, Option<f64>, Option<String>) = db
        .query_row(
            "SELECT disposition,owner_pid,owner_nonce FROM profile_source_coverage",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(owner, ("pending".into(), None, None));
    service.close().await;
}

struct CorrectionMutatingProvider {
    root: std::path::PathBuf,
}
impl ProviderPromptPort for CorrectionMutatingProvider {
    fn run_prompt<'a>(
        &'a self,
        request: ProviderPromptRequest<'a>,
        _lifecycle: ProviderPromptLifecycle<'a>,
    ) -> ProviderPromptFuture<'a> {
        let root = self.root.clone();
        let prompt = request.prompt.to_owned();
        Box::pin(async move {
            let prompt: serde_json::Value = serde_json::from_str(&prompt).unwrap();
            let target = &prompt["correction_targets"][0];
            let reference = prompt["observations"][0]["ref"].as_str().unwrap();
            storage::open(&root, true)
                .unwrap()
                .execute(
                    "UPDATE stable_profile_entries SET updated_at='changed-after-offer'",
                    [],
                )
                .unwrap();
            Ok(ProviderPromptResult {
                text: serde_json::json!({"candidates":[{
                    "category":target["category"],"facet":target["facet"],
                    "applies_when":target["applies_when"],"summary":"Corrected preference",
                    "source_type":"explicit","confidence":"high",
                    "evidence_refs":[reference],
                    "contradiction_refs":[target["target_ref"]],"sensitive_domain":false
                }]})
                .to_string(),
                model: "openai/test".into(),
                usage: None,
            })
        })
    }
}

fn coverage_identity(message: &CanonicalProfileMessage) -> (String, String) {
    let scalar = &message.parts[0].scalars[0];
    let end = scalar.text.len().to_string();
    let identity = [
        message.id.as_str(),
        scalar.source_hash.as_str(),
        message.parts[0].part_id.as_str(),
        scalar.pointer.as_str(),
        "0",
        &end,
        "profile-scalar-v1",
    ]
    .join("\0");
    let key = format!("{:x}", Sha256::digest(identity.as_bytes()));
    let evidence = format!("profile_window:{}", &key[..24]);
    (key, evidence)
}

#[tokio::test]
async fn correction_target_revision_is_revalidated_after_provider() {
    let root = Root::new("correction-race");
    let target = {
        let mut value = message("Old preference");
        value.id = "target".into();
        value.parts[0].part_id = "target-part".into();
        value
    };
    let current = message("Please correct my preference");
    let messages = Arc::new(Mutex::new(HashMap::from([
        (target.id.clone(), target.clone()),
        (current.id.clone(), current),
    ])));
    let (service, _) = service_with_parts(
        &root,
        messages,
        Arc::new(CorrectionMutatingProvider {
            root: root.0.clone(),
        }),
    );
    service
        .set_profiling_mode(ProfilingMode::Basic)
        .await
        .unwrap();
    let (key, evidence) = coverage_identity(&target);
    let db = storage::open(&root.0, true).unwrap();
    db.execute("INSERT INTO profile_source_coverage(coverage_key,message_id,source_hash,part_id,part_index,scalar_pointer,byte_start,byte_end,extractor_version,observed_at,evidence_ref,disposition,updated_at)VALUES(?1,?2,?3,?4,0,'/text',0,?5,'profile-scalar-v1',?6,?7,'complete',?6)",rusqlite::params![key,target.id,target.parts[0].scalars[0].source_hash,target.parts[0].part_id,i64::try_from(target.parts[0].scalars[0].text.len()).unwrap_or(i64::MAX),target.created_at,evidence]).unwrap();
    drop(db);
    candidates::upsert(
        &root.0,
        &ProfileCandidateInput {
            category: "communication".into(),
            payload: serde_json::json!({"summary":"Old preference"}),
            source_type: "explicit".into(),
            confidence: "high".into(),
            sensitive_domain: false,
            evidence_ref: Some(evidence),
            evidence_observed_at: Some(target.created_at),
            expires_or_decay: Some("decay".into()),
        },
        "2023-11-14T22:13:20.000Z",
    )
    .unwrap();
    service.consolidate_profile_candidates().await.unwrap();
    let result = service
        .capture_profile_candidates_from_transcripts_with_model(Default::default())
        .await
        .unwrap();
    assert_eq!(
        result.model_error.as_deref(),
        Some("profile correction target changed")
    );
    service.close().await;
}

struct DrainingProvider {
    started: Arc<Notify>,
    release: Arc<Notify>,
}
impl ProviderPromptPort for DrainingProvider {
    fn run_prompt<'a>(
        &'a self,
        request: ProviderPromptRequest<'a>,
        _lifecycle: ProviderPromptLifecycle<'a>,
    ) -> ProviderPromptFuture<'a> {
        let started = self.started.clone();
        let release = self.release.clone();
        let cancellation = request.cancellation.clone();
        Box::pin(async move {
            started.notify_one();
            cancellation.cancelled().await;
            release.notified().await;
            Err(ModelRoundError::Cancelled)
        })
    }
}

#[tokio::test]
async fn dropped_caller_keeps_claim_owned_until_close_drains_provider() {
    let root = Root::new("async-close");
    let messages = Arc::new(Mutex::new(HashMap::from([(
        "m1".into(),
        message("Please stay concise"),
    )])));
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let (service, _) = service_with_parts(
        &root,
        messages,
        Arc::new(DrainingProvider {
            started: started.clone(),
            release: release.clone(),
        }),
    );
    service
        .set_profiling_mode(ProfilingMode::Basic)
        .await
        .unwrap();
    let capture = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .capture_profile_candidates_from_transcripts_with_model(Default::default())
                .await
        })
    };
    started.notified().await;
    capture.abort();
    let close = {
        let service = service.clone();
        tokio::spawn(async move { service.close().await })
    };
    tokio::task::yield_now().await;
    assert!(!close.is_finished());
    release.notify_one();
    close.await.unwrap();
    let db = storage::open(&root.0, false).unwrap();
    let owner: (Option<f64>, Option<String>) = db
        .query_row(
            "SELECT owner_pid,owner_nonce FROM profile_source_coverage",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(owner, (None, None));
}
