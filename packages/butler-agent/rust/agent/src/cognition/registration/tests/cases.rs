mod lifecycle;

use super::*;
use rusqlite::params;
use serde_json::Value;

#[tokio::test]
async fn internal_control_without_graph_projection_completes_idempotently() {
    let fixture = Fixture::new("internal-control-noop");
    fixture
        .seed_pair_with_origin(
            "Control request",
            "Public answer",
            ConversationOriginKind::InternalControl,
        )
        .await;
    let coordinator = Arc::new(CognitionWriteCoordinator::new(Arc::new(Facts::new())).unwrap());
    let service = service(coordinator);
    for _ in 0..2 {
        let result = service
            .register_conversation_source(fixture.input("internal-control"))
            .await
            .unwrap();
        assert_eq!(
            result,
            ConversationRegistrationOutcome::InternalControlSuperseded
        );
    }
    service.close().await;
    let graph = Connection::open(fixture.graph_path()).unwrap();
    let count: i64 = graph
        .query_row("SELECT COUNT(*) FROM memory_chunks", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn registered_memory_source_reads_original_scalar_after_reopen() {
    use crate::cognition::CognitionPathEnvironment;
    use crate::context::NativeConversationSessionReference;
    use crate::conversation::CanonicalMemoryReadBinding;
    use crate::host::NativeMemorySourceReader;
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

    let fixture = Fixture::new("source-reference");
    fixture.seed().await;
    let coordinator = Arc::new(CognitionWriteCoordinator::new(Arc::new(Facts::new())).unwrap());
    let service = service(coordinator);
    let outcome = service
        .register_conversation_source(fixture.input("source-reference"))
        .await
        .unwrap();
    assert!(matches!(
        outcome,
        ConversationRegistrationOutcome::Registered(_)
    ));
    service.close().await;

    let db = Connection::open(fixture.graph_path()).unwrap();
    let source_id: String = db.query_row(
        "SELECT source_id FROM memory_chunk_sources WHERE conversation_message_id='request' ORDER BY byte_start LIMIT 1",
        [], |row| row.get(0)).unwrap();
    drop(db);
    let handle = format!(
        "memory-source:v2:{}:{}",
        URL_SAFE_NO_PAD.encode(GENERATION),
        URL_SAFE_NO_PAD.encode(source_id)
    );
    let memory = Arc::new(NativeMemorySourceReader::new(
        fixture.root.clone(),
        CognitionPathEnvironment::default(),
    ));
    let binding = CanonicalMemoryReadBinding {
        runtime_session_id: "external".into(),
        turn_id: "turn".into(),
        project_id: Some("project".into()),
    };
    let args = json!({"source_ref":handle,"scope":"current_project","max_chars":4000});
    let reader = NativeConversationSessionReference::new(&fixture.root.clone(), 2, memory.clone());
    let first = reader.read(binding.clone(), args.clone()).await.unwrap();
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["text"], "Straße remembers 🙂");
    assert_eq!(first["source_kind"], "conversation");
    reader.close().await.unwrap();

    let reopened = NativeConversationSessionReference::new(&fixture.root.clone(), 1, memory);
    let again = reopened.read(binding, args).await.unwrap();
    assert_eq!(again["text"], first["text"]);
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn registered_window_builds_canonical_pinned_extraction_input() {
    let fixture = Fixture::new("extract-input");
    fixture.seed().await;
    let coordinator = Arc::new(CognitionWriteCoordinator::new(Arc::new(Facts::new())).unwrap());
    let service = service(coordinator);
    let ConversationRegistrationOutcome::Registered(progress) = service
        .register_conversation_source(fixture.input("input"))
        .await
        .unwrap()
    else {
        panic!("registration expected")
    };
    service.close().await;

    let graph = GraphRepository::open(&fixture.graph_path()).unwrap();
    let canonical = ConversationSourceReader::open(&fixture.canonical_path()).unwrap();
    let connection = Connection::open(fixture.graph_path()).unwrap();
    let (window, refs): (String, String) = connection.query_row(
        "SELECT window_ref,source_refs_json FROM memory_projection_windows WHERE job_id=?1 ORDER BY ordinal LIMIT 1",
        [&progress.job_id], |row| Ok((row.get(0)?,row.get(1)?)),
    ).unwrap();
    let refs: Vec<String> = serde_json::from_str(&refs).unwrap();
    let input = graph
        .build_extract_input(&canonical, &fixture.root, &progress.job_id, &window, &refs)
        .unwrap();
    assert_eq!(input.window_ref, window);
    assert_eq!(input.source_units.len(), 1);
    assert_eq!(input.source_units[0].text, "Straße remembers 🙂");
    assert_eq!(input.bound_project_id.as_deref(), Some("project"));
    assert_eq!(input.context_expansion, Some(0.0));
    assert!(
        input
            .context_units
            .iter()
            .all(|unit| unit.source_span.is_none())
    );
    canonical.close().unwrap();
    graph.close().unwrap();
}

#[tokio::test]
async fn claimed_window_meaning_and_bound_apply_are_durable() {
    use crate::cognition::extraction::{ExtractNode, ExtractOutput, NodeResolution, QuoteRef};
    use crate::cognition::graph::ClaimProjectionWindowInput;

    let fixture = Fixture::new("semantic-apply");
    fixture.seed().await;
    let coordinator = Arc::new(CognitionWriteCoordinator::new(Arc::new(Facts::new())).unwrap());
    let service = service(coordinator);
    let ConversationRegistrationOutcome::Registered(progress) = service
        .register_conversation_source(fixture.input("apply"))
        .await
        .unwrap()
    else {
        panic!("registration expected")
    };
    service.close().await;

    let mut graph = GraphRepository::open(&fixture.graph_path()).unwrap();
    let canonical = ConversationSourceReader::open(&fixture.canonical_path()).unwrap();
    let owners = std::collections::HashSet::new();
    let claim = graph
        .claim_projection_window(ClaimProjectionWindowInput {
            job_id: Some(&progress.job_id),
            now: NOW,
            owner_pid: 42,
            owner_nonce: "nonce-apply",
            active_owners: &owners,
            process_status: &|_| CognitionProcessStatus::Alive,
        })
        .unwrap()
        .unwrap();
    let input = graph
        .build_extract_input(
            &canonical,
            &fixture.root,
            &claim.job_id,
            &claim.window_ref,
            &claim.source_refs,
        )
        .unwrap();
    graph
        .pin_projection_input(
            &claim.window_ref,
            &claim.owner_nonce,
            &serde_json::to_value(&input).unwrap(),
            None,
        )
        .unwrap();
    let output = ExtractOutput {
        schema: "butler.memory-extract-output.v3".into(),
        window_ref: claim.window_ref.clone(),
        disposition: "processed".into(),
        covered_unit_refs: input
            .source_units
            .iter()
            .map(|unit| unit.ref_id.clone())
            .collect(),
        nodes: vec![ExtractNode {
            local_ref: "n0".into(),
            node_type: "entity".into(),
            label: "Straße".into(),
            resolution: NodeResolution::Create {
                provisional: true,
                identity_scope: "project".into(),
            },
            aliases: vec![],
            evidence: vec![QuoteRef {
                unit_ref: input.source_units[0].ref_id.clone(),
                quote: input.source_units[0].text.clone(),
                occurrence: 0,
            }],
        }],
        claims: vec![],
        relations: vec![],
        corrections: vec![],
        summary: None,
    };
    graph
        .commit_meaning(
            &claim.job_id,
            &claim.window_ref,
            &claim.owner_nonce,
            &input,
            &output,
            NOW,
        )
        .unwrap();
    let plan = graph.normalize_plan(&input, &output).unwrap();
    graph
        .save_validated_plan(
            &claim.job_id,
            &claim.window_ref,
            &claim.owner_nonce,
            &serde_json::to_value(&output).unwrap(),
            &serde_json::to_value(&plan).unwrap(),
        )
        .unwrap();
    graph
        .apply_final(
            crate::cognition::graph::ProjectionWindowOwner {
                job_id: &claim.job_id,
                window_ref: &claim.window_ref,
                nonce: &claim.owner_nonce,
            },
            &input,
            &output,
            &plan,
            NOW,
        )
        .unwrap();
    canonical.close().unwrap();
    graph.close().unwrap();

    let reopened = Connection::open(fixture.graph_path()).unwrap();
    let state: (String, Option<String>) = reopened
        .query_row(
            "SELECT state,owner_nonce FROM memory_projection_windows WHERE window_ref=?1",
            [&claim.window_ref],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(state, ("complete".into(), None));
    let counts:(i64,i64,i64,i64)=reopened.query_row("SELECT (SELECT COUNT(*) FROM memory_meaning_commits),(SELECT COUNT(*) FROM memory_nodes WHERE window_ref IS NOT NULL),(SELECT COUNT(*) FROM memory_evidence),(SELECT COUNT(*) FROM memory_alias_postings)",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).unwrap();
    assert_eq!(counts.0, 1);
    assert_eq!(counts.1, 1);
    assert_eq!(counts.2, 1);
    assert!(counts.3 > 0);
}

#[tokio::test]
async fn actual_canonical_writer_registers_and_replays_exact_durable_projection() {
    let fixture = Fixture::new("register");
    fixture.seed().await;
    let coordinator = Arc::new(CognitionWriteCoordinator::new(Arc::new(Facts::new())).unwrap());
    let service = service(coordinator);
    let ConversationRegistrationOutcome::Registered(first) = service
        .register_conversation_source(fixture.input("z"))
        .await
        .unwrap()
    else {
        panic!("first call must register")
    };
    assert_eq!(first.outcome, "partial");
    assert_eq!(first.observed_completion_job_ids, ["z"]);

    let db = Connection::open(fixture.graph_path()).unwrap();
    let chunk: (String, String, String, String, String) = db.query_row(
        "SELECT conversation_start,conversation_end,project_id,origin_kind,status FROM memory_chunks",
        [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
    ).unwrap();
    assert_eq!(
        chunk,
        (
            "2026-09-14T00:00:01.000Z".into(),
            "2026-09-14T00:00:02.000Z".into(),
            "project".into(),
            "user_input".into(),
            "active".into(),
        )
    );
    let counts: (i64,i64,i64,i64) = db.query_row(
        "SELECT (SELECT COUNT(*) FROM memory_chunk_sources),(SELECT COUNT(*) FROM memory_source_text),(SELECT COUNT(*) FROM memory_projection_jobs),(SELECT COUNT(*) FROM memory_projection_windows)",
        [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
    ).unwrap();
    assert_eq!(counts, (2, 2, 1, 2));
    let strasse: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM memory_source_terms WHERE term='strasse'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        strasse, 0,
        "index terms are graphemes and 2/3-grams, not whole words"
    );
    drop(db);

    let ConversationRegistrationOutcome::Replayed(replay) = service
        .register_conversation_source(fixture.input("a"))
        .await
        .unwrap()
    else {
        panic!("same revision must replay")
    };
    assert_eq!(replay.job_id, first.job_id);
    assert_eq!(replay.observed_completion_job_ids, ["a", "z"]);
    let db = Connection::open(fixture.graph_path()).unwrap();
    let counts: (i64,i64,i64) = db.query_row(
        "SELECT (SELECT COUNT(*) FROM memory_chunk_sources),(SELECT COUNT(*) FROM memory_projection_jobs),(SELECT COUNT(*) FROM memory_projection_windows)",
        [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).unwrap();
    assert_eq!(counts, (2, 1, 2));
    service.close().await;
}

#[tokio::test]
async fn new_revision_retains_history_and_invalidates_current_identity_head_atomically() {
    let fixture = Fixture::new("revision");
    fixture.seed().await;
    let coordinator = Arc::new(CognitionWriteCoordinator::new(Arc::new(Facts::new())).unwrap());
    let service = service(coordinator);
    let ConversationRegistrationOutcome::Registered(first) = service
        .register_conversation_source(fixture.input("first"))
        .await
        .unwrap()
    else {
        panic!("first revision must register")
    };
    let graph = Connection::open(fixture.graph_path()).unwrap();
    let old_source: String = graph
        .query_row(
            "SELECT source_id FROM memory_chunk_sources ORDER BY source_id LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let decision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let record = json!({
        "decision_ref":decision,
        "operation":"apply",
        "literal_loser":"loser",
        "literal_canonical":"canonical",
        "source_refs":[old_source],
        "previous_direct_redirect":null,
        "previous_head":null
    });
    graph.execute(
        "INSERT INTO memory_nodes(id,type,label_original,identity_scope,created_at,identity_history_job_id,identity_history_ref) VALUES('loser','entity','Loser','user',?1,?2,?3)",
        params![NOW,first.job_id,decision],
    ).unwrap();
    graph
        .execute(
            "UPDATE memory_projection_jobs SET identity_decisions_json=?1 WHERE job_id=?2",
            params![json!([record]).to_string(), first.job_id],
        )
        .unwrap();
    graph
        .execute(
            "INSERT INTO memory_chunk_graph_refs VALUES(?1,'identity_source_job',?2,?3)",
            params![
                first.episode_id,
                old_source,
                format!("identity_job:{}", first.job_id)
            ],
        )
        .unwrap();
    drop(graph);

    fixture.advance_turn().await;
    let ConversationRegistrationOutcome::Registered(second) = service
        .register_conversation_source(fixture.input_generation("second", 2.0))
        .await
        .unwrap()
    else {
        panic!("new revision must register")
    };
    let graph = Connection::open(fixture.graph_path()).unwrap();
    assert_eq!(
        graph
            .query_row("SELECT COUNT(*) FROM memory_projection_jobs", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    let head: (Option<String>, String) = graph
        .query_row(
            "SELECT canonical_node_id,identity_history_job_id FROM memory_nodes WHERE id='loser'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(head, (None, second.job_id.clone()));
    let history: String = graph
        .query_row(
            "SELECT identity_decisions_json FROM memory_projection_jobs WHERE job_id=?1",
            [&second.job_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&history).unwrap()[0]["operation"],
        "invalidate"
    );
    service.close().await;
}
