use super::*;
use serde_json::Value;
mod lifecycle;
mod native;
mod ranked;
use crate::{
    cognition::{
        extraction::{CandidateSearchInput, CognitionVectorSearch, VectorSearchFuture},
        registration::projection::ProjectSemanticWindowInput,
    },
    models::{
        ProviderPromptFuture, ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest,
        ProviderPromptResult,
    },
};

struct NoVectors;
impl CognitionVectorSearch for NoVectors {
    fn search<'a>(&'a self, _: CandidateSearchInput<'a>) -> VectorSearchFuture<'a> {
        panic!("embedding-none must not invoke vector search")
    }
}
struct MeaningProvider;
impl ProviderPromptPort for MeaningProvider {
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
            let text = if request.prompt.contains("\"speaker\":\"user\"") {
                serde_json::json!({"status":"processed","entities":[{"name":"Straße","evidence":[0]}],"items":[],"attributes":[]})
            } else {
                serde_json::json!({"status":"processed","entities":[],"items":[],"attributes":[]})
            };
            Ok(ProviderPromptResult {
                text: text.to_string(),
                model: "provider/model".into(),
                usage: None,
            })
        })
    }
}
struct BindingProvider;
impl ProviderPromptPort for BindingProvider {
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
            let text = if request.prompt.contains("\"targets\"") {
                serde_json::json!({"decisions":[{"target":"n0","candidate":"n0c0","span":null,"support":["n0u0","n0c0h"]}]})
            } else {
                serde_json::json!({"status":"processed","entities":[{"name":"Straße","evidence":[0]}],"items":[],"attributes":[]})
            };
            Ok(ProviderPromptResult {
                text: text.to_string(),
                model: "provider/model".into(),
                usage: None,
            })
        })
    }
}
struct DispositionProvider(&'static str);
impl ProviderPromptPort for DispositionProvider {
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
            Ok(ProviderPromptResult {
                text: serde_json::json!({"status":self.0,"entities":[],"items":[],"attributes":[]})
                    .to_string(),
                model: "provider/model".into(),
                usage: None,
            })
        })
    }
}

#[tokio::test]
async fn same_operation_semantic_apply_reopens_without_live_nonce() {
    let fixture = Fixture::new("semantic-operation");
    fixture.seed().await;
    let facts = Arc::new(Facts::new());
    let coordinator = Arc::new(CognitionWriteCoordinator::new(facts.clone()).unwrap());
    let service = CognitionRegistrationService::with_projection(
        CognitionPathEnvironment::default(),
        coordinator,
        Arc::new(|| NOW.into()),
        Arc::new(MeaningProvider),
        Arc::new(NoVectors),
        facts,
    );
    let registered = service
        .register_conversation_source(fixture.input("semantic-operation"))
        .await
        .unwrap();
    let ConversationRegistrationOutcome::Registered(progress) = registered else {
        panic!("expected registration")
    };
    let input = ProjectSemanticWindowInput {
        data_root: fixture.root.clone(),
        target: MemoryGenerationTarget::Active {
            expected_generation: GENERATION.into(),
        },
        job_id: progress.job_id.clone(),
        notice: fixture.input("semantic-operation").notice.into(),
        cancellation: None,
        deadline_at_epoch_ms: None,
        wait_class: CognitionWaitClass::Background,
    };
    let first = service
        .project_semantic_window(input.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first.semantic_graph["state"], "partial");
    service
        .project_semantic_window(input.clone())
        .await
        .unwrap()
        .unwrap();
    assert!(
        service
            .project_semantic_window(input)
            .await
            .unwrap()
            .is_none()
    );
    service.close().await;
    let graph = Connection::open(fixture.graph_path()).unwrap();
    let states: Vec<(String, Option<String>)> = graph
        .prepare("SELECT state,owner_nonce FROM memory_projection_windows ORDER BY ordinal")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        states,
        [("complete".into(), None), ("complete".into(), None)]
    );
    let counts:(i64,i64,i64,i64)=graph.query_row("SELECT (SELECT COUNT(*) FROM memory_meaning_commits),(SELECT COUNT(*) FROM memory_nodes WHERE window_ref IS NOT NULL),(SELECT COUNT(*) FROM memory_alias_postings),(SELECT COUNT(*) FROM memory_vector_units WHERE state='pending')",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
    let stage: (String, String) = graph
        .query_row(
            "SELECT node_vectors_state,episode_vectors_state FROM memory_projection_jobs LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(counts.0, 2);
    assert!(counts.1 >= 1);
    assert!(counts.2 > 0);
    assert!(counts.3 > 0, "vector stages: {stage:?}");
    assert_eq!(
        serde_json::from_str::<Value>(&stage.0).unwrap()["state"],
        "pending"
    );
    assert_eq!(
        serde_json::from_str::<Value>(&stage.1).unwrap()["state"],
        "pending"
    );
}

#[tokio::test]
async fn second_registered_window_binds_durable_first_window_identity() {
    let fixture = Fixture::new("semantic-binding");
    fixture
        .seed_pair("Straße remembers 🙂", "Straße remembers too.")
        .await;
    let facts = Arc::new(Facts::new());
    let coordinator = Arc::new(CognitionWriteCoordinator::new(facts.clone()).unwrap());
    let service = CognitionRegistrationService::with_projection(
        CognitionPathEnvironment::default(),
        coordinator,
        Arc::new(|| NOW.into()),
        Arc::new(BindingProvider),
        Arc::new(NoVectors),
        facts,
    );
    let registered = service
        .register_conversation_source(fixture.input("semantic-binding"))
        .await
        .unwrap();
    let ConversationRegistrationOutcome::Registered(progress) = registered else {
        panic!("expected registration")
    };
    let input = ProjectSemanticWindowInput {
        data_root: fixture.root.clone(),
        target: MemoryGenerationTarget::Active {
            expected_generation: GENERATION.into(),
        },
        job_id: progress.job_id.clone(),
        notice: fixture.input("semantic-binding").notice.into(),
        cancellation: None,
        deadline_at_epoch_ms: None,
        wait_class: CognitionWaitClass::Background,
    };
    service
        .project_semantic_window(input.clone())
        .await
        .unwrap()
        .unwrap();
    service
        .project_semantic_window(input)
        .await
        .unwrap()
        .unwrap();
    service.close().await;
    let graph = Connection::open(fixture.graph_path()).unwrap();
    let identity_matches: i64 = graph
        .query_row(
            "SELECT COUNT(*) FROM edges WHERE rel_type='identity_match'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let states: Vec<String> = graph
        .prepare("SELECT state FROM memory_projection_windows ORDER BY ordinal")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(states, ["complete", "complete"]);
    assert_eq!(
        identity_matches, 1,
        "second window must bind to the first durable identity"
    );
}

#[tokio::test]
async fn unsupported_meaning_records_warning_without_graph_precommit() {
    let fixture = Fixture::new("unsupported-meaning");
    fixture.seed().await;
    let facts = Arc::new(Facts::new());
    let coordinator = Arc::new(CognitionWriteCoordinator::new(facts.clone()).unwrap());
    let service = CognitionRegistrationService::with_projection(
        CognitionPathEnvironment::default(),
        coordinator,
        Arc::new(|| NOW.into()),
        Arc::new(DispositionProvider("unsupported")),
        Arc::new(NoVectors),
        facts,
    );
    let ConversationRegistrationOutcome::Registered(progress) = service
        .register_conversation_source(fixture.input("unsupported"))
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
        notice: fixture.input("unsupported").notice.into(),
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
    let graph = Connection::open(fixture.graph_path()).unwrap();
    let row:(String,Option<String>,String)=graph.query_row("SELECT state,owner_nonce,provider_evidence_json FROM memory_projection_windows ORDER BY ordinal LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(row.0, "unsupported");
    assert_eq!(row.1, None);
    assert_eq!(
        serde_json::from_str::<Value>(&row.2).unwrap()["disposition"],
        "unsupported"
    );
    let commits: i64 = graph
        .query_row("SELECT COUNT(*) FROM memory_meaning_commits", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(commits, 0);
}

#[tokio::test]
async fn needs_context_records_one_bounded_input_recovery() {
    let fixture = Fixture::new("needs-context");
    fixture.seed().await;
    let facts = Arc::new(Facts::new());
    let coordinator = Arc::new(CognitionWriteCoordinator::new(facts.clone()).unwrap());
    let service = CognitionRegistrationService::with_projection(
        CognitionPathEnvironment::default(),
        coordinator,
        Arc::new(|| NOW.into()),
        Arc::new(DispositionProvider("needs_context")),
        Arc::new(NoVectors),
        facts,
    );
    let ConversationRegistrationOutcome::Registered(progress) = service
        .register_conversation_source(fixture.input("context"))
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
        notice: fixture.input("context").notice.into(),
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
    let graph = Connection::open(fixture.graph_path()).unwrap();
    let row:(String,Option<String>,String)=graph.query_row("SELECT state,owner_nonce,input_json FROM memory_projection_windows ORDER BY ordinal LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(row.0, "pending");
    assert_eq!(row.1, None);
    assert_eq!(
        serde_json::from_str::<Value>(&row.2).unwrap()["context_expansion"],
        1
    );
    let recoveries: i64 = graph
        .query_row(
            "SELECT COUNT(*) FROM memory_projection_attempts WHERE state='recovery_requested'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(recoveries, 1);
}
