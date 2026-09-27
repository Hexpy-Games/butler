use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::models::ProviderPromptError;

struct CancelledProvider {
    entered: Arc<Notify>,
}
impl ProviderPromptPort for CancelledProvider {
    fn run_prompt<'a>(
        &'a self,
        request: ProviderPromptRequest<'a>,
        lifecycle: ProviderPromptLifecycle<'a>,
    ) -> ProviderPromptFuture<'a> {
        Box::pin(async move {
            if let Some(intent) = lifecycle.invocation_intent {
                intent.invoked().await?;
            }
            if let Some(entry) = lifecycle.adapter_entry {
                entry.entered()?;
            }
            self.entered.notify_one();
            request.cancellation.cancelled().await;
            Err(ProviderPromptError::InvocationFailure {
                code: Some("cancelled".into()),
                message: "cancelled".into(),
            })
        })
    }
}

#[tokio::test]
async fn caller_cancellation_settles_terminal_failure_under_original_nonce() {
    let fixture = Fixture::new("semantic-cancel");
    fixture.seed().await;
    let facts = Arc::new(Facts::new());
    let coordinator = Arc::new(CognitionWriteCoordinator::new(facts.clone()).unwrap());
    let entered = Arc::new(Notify::new());
    let cancellation = CancellationToken::new();
    let service = CognitionRegistrationService::with_projection(
        CognitionPathEnvironment::default(),
        coordinator,
        Arc::new(|| NOW.into()),
        Arc::new(CancelledProvider {
            entered: entered.clone(),
        }),
        Arc::new(NoVectors),
        facts,
    );
    let ConversationRegistrationOutcome::Registered(progress) = service
        .register_conversation_source(fixture.input("cancel"))
        .await
        .unwrap()
    else {
        panic!("expected registration")
    };
    let input = ProjectSemanticWindowInput {
        data_root: fixture.root.clone(),
        target: MemoryGenerationTarget::Active {
            expected_generation: GENERATION.into(),
        },
        job_id: progress.job_id,
        notice: fixture.input("cancel").notice.into(),
        cancellation: Some(cancellation.clone()),
        deadline_at_epoch_ms: None,
        wait_class: CognitionWaitClass::Background,
    };
    let running = tokio::spawn({
        let service = Arc::new(service);
        let cloned = service.clone();
        async move { (service, cloned.project_semantic_window(input).await) }
    });
    entered.notified().await;
    cancellation.cancel();
    let (service, result) = running.await.unwrap();
    result.unwrap().unwrap();
    service.close().await;
    let graph = Connection::open(fixture.graph_path()).unwrap();
    let row:(String,Option<String>,String)=graph.query_row("SELECT state,owner_nonce,error_code FROM memory_projection_windows ORDER BY ordinal LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(
        row,
        ("failed".into(), None, "memory_extract_cancelled".into())
    );
}

struct GateProvider {
    entered: Arc<Notify>,
    release: Arc<Notify>,
}
impl ProviderPromptPort for GateProvider {
    fn run_prompt<'a>(
        &'a self,
        _: ProviderPromptRequest<'a>,
        lifecycle: ProviderPromptLifecycle<'a>,
    ) -> ProviderPromptFuture<'a> {
        Box::pin(async move {
            if let Some(intent) = lifecycle.invocation_intent {
                intent.invoked().await?;
            }
            if let Some(entry) = lifecycle.adapter_entry {
                entry.entered()?;
            }
            self.entered.notify_one();
            self.release.notified().await;
            Ok(ProviderPromptResult{text:serde_json::json!({"status":"processed","entities":[],"items":[],"attributes":[]}).to_string(),
                model:"provider/model".into(),usage:None})
        })
    }
}

#[tokio::test]
async fn dropping_caller_keeps_tracked_projection_until_close_drains() {
    let fixture = Fixture::new("semantic-drop");
    fixture.seed().await;
    let facts = Arc::new(Facts::new());
    let coordinator = Arc::new(CognitionWriteCoordinator::new(facts.clone()).unwrap());
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let service = Arc::new(CognitionRegistrationService::with_projection(
        CognitionPathEnvironment::default(),
        coordinator,
        Arc::new(|| NOW.into()),
        Arc::new(GateProvider {
            entered: entered.clone(),
            release: release.clone(),
        }),
        Arc::new(NoVectors),
        facts,
    ));
    let ConversationRegistrationOutcome::Registered(progress) = service
        .register_conversation_source(fixture.input("drop"))
        .await
        .unwrap()
    else {
        panic!("expected registration")
    };
    let input = ProjectSemanticWindowInput {
        data_root: fixture.root.clone(),
        target: MemoryGenerationTarget::Active {
            expected_generation: GENERATION.into(),
        },
        job_id: progress.job_id,
        notice: fixture.input("drop").notice.into(),
        cancellation: None,
        deadline_at_epoch_ms: None,
        wait_class: CognitionWaitClass::Background,
    };
    let caller = tokio::spawn({
        let service = service.clone();
        async move { service.project_semantic_window(input).await }
    });
    entered.notified().await;
    caller.abort();
    release.notify_one();
    service.close().await;
    let graph = Connection::open(fixture.graph_path()).unwrap();
    let row: (String, Option<String>) = graph
        .query_row(
            "SELECT state,owner_nonce FROM memory_projection_windows ORDER BY ordinal LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(matches!(row.0.as_str(), "complete" | "failed"));
    assert_eq!(row.1, None);
}

struct InvalidProvider {
    calls: Arc<AtomicUsize>,
}
impl ProviderPromptPort for InvalidProvider {
    fn run_prompt<'a>(
        &'a self,
        _: ProviderPromptRequest<'a>,
        lifecycle: ProviderPromptLifecycle<'a>,
    ) -> ProviderPromptFuture<'a> {
        Box::pin(async move {
            if let Some(intent) = lifecycle.invocation_intent {
                intent.invoked().await?;
            }
            if let Some(entry) = lifecycle.adapter_entry {
                entry.entered()?;
            }
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(ProviderPromptResult {
                text: "{\"status\":\"processed\"}".into(),
                model: "provider/model".into(),
                usage: None,
            })
        })
    }
}

#[tokio::test]
async fn exhausted_stage_repairs_are_terminal_and_durably_replayable() {
    let fixture = Fixture::new("semantic-repairs");
    fixture.seed().await;
    let facts = Arc::new(Facts::new());
    let coordinator = Arc::new(CognitionWriteCoordinator::new(facts.clone()).unwrap());
    let calls = Arc::new(AtomicUsize::new(0));
    let service = CognitionRegistrationService::with_projection(
        CognitionPathEnvironment::default(),
        coordinator,
        Arc::new(|| NOW.into()),
        Arc::new(InvalidProvider {
            calls: calls.clone(),
        }),
        Arc::new(NoVectors),
        facts,
    );
    let ConversationRegistrationOutcome::Registered(progress) = service
        .register_conversation_source(fixture.input("repairs"))
        .await
        .unwrap()
    else {
        panic!("expected registration")
    };
    let input = ProjectSemanticWindowInput {
        data_root: fixture.root.clone(),
        target: MemoryGenerationTarget::Active {
            expected_generation: GENERATION.into(),
        },
        job_id: progress.job_id,
        notice: fixture.input("repairs").notice.into(),
        cancellation: None,
        deadline_at_epoch_ms: None,
        wait_class: CognitionWaitClass::Background,
    };
    service
        .project_semantic_window(input)
        .await
        .unwrap()
        .unwrap();
    service.close().await;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        3,
        "source permits two repairs after the original stage"
    );
    let graph = Connection::open(fixture.graph_path()).unwrap();
    let row:(String,Option<String>,Option<String>,String)=graph.query_row("SELECT state,owner_nonce,next_attempt_at,extraction_stages_json FROM memory_projection_windows ORDER BY ordinal LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
    assert_eq!(row.0, "failed");
    assert_eq!(row.1, None);
    assert_eq!(row.2, None);
    assert_eq!(
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&row.3)
            .unwrap()
            .len(),
        3
    );
}
