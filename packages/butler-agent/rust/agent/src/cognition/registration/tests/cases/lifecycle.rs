use super::*;

#[tokio::test]
async fn canonical_change_while_waiting_rolls_back_and_close_waits_for_operation() {
    let fixture = Fixture::new("changed");
    fixture.seed().await;
    let facts = Arc::new(Facts::new());
    let coordinator = Arc::new(CognitionWriteCoordinator::new(facts.clone()).unwrap());
    let held = coordinator
        .try_acquire(CognitionWriteAcquire::immediate(
            fixture.lock_path(),
            "fixture",
        ))
        .unwrap()
        .unwrap();
    let calls_before_registration = facts.now_calls.load(AtomicOrdering::Acquire);
    let service = service(coordinator.clone());
    let running = {
        let service = service.clone();
        let input = fixture.input("completion");
        tokio::spawn(async move { service.register_conversation_source(input).await })
    };
    crate::testing::eventually("registration to wait for the write gate", || {
        facts.now_calls.load(AtomicOrdering::Acquire) != calls_before_registration
    })
    .await;
    let db = Connection::open(fixture.canonical_path()).unwrap();
    db.execute(
        "UPDATE conversation_turn_outcomes SET generation=2 WHERE turn_id='turn'",
        [],
    )
    .unwrap();
    drop(db);
    held.release(false).unwrap();
    let error = running.await.unwrap().unwrap_err();
    assert_eq!(error.code, "memory_source_changed");
    let graph = Connection::open(fixture.graph_path()).unwrap();
    let jobs = graph.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='memory_projection_jobs'",
        [], |row| row.get::<_,i64>(0),
    ).unwrap();
    if jobs == 1 {
        assert_eq!(
            graph
                .query_row("SELECT COUNT(*) FROM memory_projection_jobs", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    drop(graph);
    service.close().await;
}

#[tokio::test]
async fn caller_drop_does_not_detach_wait_and_close_cancels_and_drains_it() {
    let fixture = Fixture::new("caller-drop");
    fixture.seed().await;
    let facts = Arc::new(Facts::new());
    let coordinator = Arc::new(CognitionWriteCoordinator::new(facts.clone()).unwrap());
    let held = coordinator
        .try_acquire(CognitionWriteAcquire::immediate(
            fixture.lock_path(),
            "fixture",
        ))
        .unwrap()
        .unwrap();
    let calls_before_registration = facts.now_calls.load(AtomicOrdering::Acquire);
    let service = service(coordinator);
    let caller = {
        let service = service.clone();
        let input = fixture.input("completion");
        tokio::spawn(async move { service.register_conversation_source(input).await })
    };
    crate::testing::eventually("registration to wait for the write gate", || {
        facts.now_calls.load(AtomicOrdering::Acquire) != calls_before_registration
    })
    .await;
    caller.abort();
    service.close().await;
    held.release(false).unwrap();

    let error = service
        .register_conversation_source(fixture.input("after-close"))
        .await
        .unwrap_err();
    assert_eq!(error.code, "cognition_closed");
}

#[tokio::test]
async fn cancellation_after_initial_check_aborts_acquire_before_schema_mutation() {
    let fixture = Fixture::new("cancel-before-acquire");
    fixture.seed().await;
    let cancellation = tokio_util::sync::CancellationToken::new();
    let cancel_from_clock = cancellation.clone();
    let coordinator = Arc::new(CognitionWriteCoordinator::new(Arc::new(Facts::new())).unwrap());
    let service = service_with_clock(
        coordinator,
        Arc::new(move || {
            cancel_from_clock.cancel();
            NOW.into()
        }),
    );
    let mut input = fixture.input("completion");
    input.cancellation = Some(cancellation);
    let error = service
        .register_conversation_source(input)
        .await
        .unwrap_err();
    assert_eq!(error.code, "memory_write_aborted");

    let graph = Connection::open(fixture.graph_path()).unwrap();
    let schema_tables: i64 = graph
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='memory_projection_jobs'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(schema_tables, 0);
    service.close().await;
}

#[tokio::test]
async fn oversized_single_grapheme_rolls_back_the_registration_transaction() {
    let fixture = Fixture::new("oversized");
    let oracle: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/bun-pack-window.json")).unwrap();
    let oversized = format!("a{}", "\u{301}".repeat(5_000));
    assert_eq!(
        oversized.len() as u64,
        oracle["utf8_bytes"].as_u64().unwrap()
    );
    fixture.seed_with_text(&oversized).await;
    let coordinator = Arc::new(CognitionWriteCoordinator::new(Arc::new(Facts::new())).unwrap());
    let service = service(coordinator);
    let error = service
        .register_conversation_source(fixture.input("completion"))
        .await
        .unwrap_err();
    assert_eq!(error.code, oracle["error"].as_str().unwrap());

    let graph = Connection::open(fixture.graph_path()).unwrap();
    for table in [
        "memory_chunks",
        "memory_chunk_sources",
        "memory_projection_jobs",
        "memory_projection_windows",
    ] {
        let count: i64 = graph
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "{table} must roll back with packWindows");
    }
    service.close().await;
}

#[test]
fn generation_errors_and_node_join_preserve_source_contract() {
    let fixture = Fixture::new("generation");
    std::fs::create_dir_all(fixture.graph_path().parent().unwrap()).unwrap();
    std::fs::write(
        fixture.root.join("cognition/memory/active-generation.json"),
        json!({"schema":"butler.memory-active-generation.v2","generation_id":GENERATION,"projection_mode":"running"}).to_string(),
    ).unwrap();
    std::fs::write(
        fixture.graph_path().parent().unwrap().join("manifest.json"),
        json!({"schema":"butler.memory-generation.v2","generation_id":GENERATION,"format":"v2"})
            .to_string(),
    )
    .unwrap();
    let error = resolve_generation(
        &fixture.root,
        &CognitionPathEnvironment::default(),
        &MemoryGenerationTarget::Active {
            expected_generation: GENERATION.into(),
        },
    )
    .unwrap_err();
    assert_eq!(error.code, "memory_embedding_metadata_invalid");
}
