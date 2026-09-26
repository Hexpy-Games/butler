use super::*;

#[tokio::test]
async fn post_dispatch_and_post_receipt_faults_settle_same_durable_occurrence() {
    let (_fixture, storage, work) = ready("effect-fault-settlement").await;
    let calls = Arc::new(AtomicUsize::new(0));
    let adapter: Arc<dyn EffectAdapter> = Arc::new(FixtureAdapter {
        calls: Arc::clone(&calls),
        result: crate::json::JsonDocument::from_value(&json!({"done":true})).unwrap(),
        binding: PlanBinding::AcceptedPlan,
    });
    let journal = Arc::new(StorageEffectJournal::new(storage.clone(), clock()));
    let first = NativeEffectService::with_fault_points(
        journal.clone(),
        clock(),
        Arc::new(FailAt("after_dispatch")),
    );
    let mut input = invocation(work.clone(), Arc::clone(&adapter), CancellationToken::new());
    input.occurrence_id = Some("first".into());
    assert!(matches!(
        first.execute(input).await.unwrap(),
        EffectOutcome::Applied {
            replayed: false,
            ..
        }
    ));
    let second = NativeEffectService::with_fault_points(
        journal.clone(),
        clock(),
        Arc::new(FailAt("after_receipt")),
    );
    let mut input = invocation(work.clone(), Arc::clone(&adapter), CancellationToken::new());
    input.occurrence_id = Some("second".into());
    assert!(matches!(
        second.execute(input).await.unwrap(),
        EffectOutcome::Applied { replayed: true, .. }
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let records = journal.list_for_work(work.work_id, None).await.unwrap();
    assert_eq!(records.len(), 2);
    assert!(
        records
            .iter()
            .all(|record| record.status == EffectStatus::Applied)
    );
    storage.close().await.unwrap();
}

#[tokio::test]
async fn legacy_blocker_grouping_preserves_first_payload_and_conservative_relation() {
    let (_fixture, storage, work) = ready("effect-legacy-blockers").await;
    // Explicit legacy fixture: blocker rows originate in an older process and
    // are not fabricated by the production Effect service.
    let work_id = work.work_id.clone();
    storage
        .execute(move |db| {
            let input = r#"{"path":"a","content":"x"}"#;
            let sha = super::identity::digest(input);
            for (id, target) in [("old-a", "workspace:a"), ("old-b", "workspace:b")] {
                db.execute(
                    "INSERT INTO btcc_guided_work_effect_blockers
                (blocker_id,source_turn_id,source_occurrence_id,session_id,work_id,capability,
                 target,input_json,input_sha256,idempotency_key,detail,status,created_at)
                VALUES (?1,'turn','legacy-occurrence','session',?2,'write_file',?3,?4,?5,
                    'legacy-key','prior effect','unresolved','2026-09-19T00:00:00.000Z')",
                    rusqlite::params![id, work_id, target, input, sha],
                )
                .map_err(crate::btcc::storage::StorageError::sqlite)?;
            }
            db.execute(
                "UPDATE btcc_guided_works SET status='blocked' WHERE work_id=?1",
                [work_id],
            )
            .map_err(crate::btcc::storage::StorageError::sqlite)?;
            Ok(())
        })
        .await
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let adapter: Arc<dyn EffectAdapter> = Arc::new(FixtureAdapter {
        calls: Arc::clone(&calls),
        result: crate::json::JsonDocument::from_value(&json!({"done":true})).unwrap(),
        binding: PlanBinding::AcceptedPlan,
    });
    let journal = Arc::new(StorageEffectJournal::new(storage.clone(), clock()));
    let service = NativeEffectService::new(journal.clone(), clock());
    assert!(matches!(
        service
            .execute(invocation(work.clone(), adapter, CancellationToken::new()))
            .await
            .unwrap(),
        EffectOutcome::Applied {
            replayed: false,
            ..
        }
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let blockers = journal.blockers(work.work_id.clone()).await.unwrap();
    assert_eq!(blockers.len(), 2);
    assert!(blockers.iter().all(|row| row.status == "applied"));
    let state: String = storage
        .execute(move |db| {
            db.query_row(
                "SELECT status FROM btcc_guided_works WHERE work_id=?1",
                [work.work_id],
                |row| row.get(0),
            )
            .map_err(crate::btcc::storage::StorageError::sqlite)
        })
        .await
        .unwrap();
    assert_eq!(state, "open");
    storage.close().await.unwrap();
}

#[tokio::test]
async fn cancellation_before_intent_and_after_claim_preserve_source_dispatch_boundary() {
    let (_fixture, storage, work) = ready("effect-cancel").await;
    let calls = Arc::new(AtomicUsize::new(0));
    let adapter: Arc<dyn EffectAdapter> = Arc::new(FixtureAdapter {
        calls: Arc::clone(&calls),
        result: crate::json::JsonDocument::from_value(&json!({"ok":true})).unwrap(),
        binding: PlanBinding::AcceptedPlan,
    });
    let journal = Arc::new(StorageEffectJournal::new(storage.clone(), clock()));
    let service = NativeEffectService::new(journal.clone(), clock());
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(
        matches!(service.execute(invocation(work.clone(),Arc::clone(&adapter),cancelled)).await.unwrap(),
        EffectOutcome::Rejected(error) if error.code=="effect_cancelled")
    );
    assert!(
        journal
            .list_for_work(work.work_id.clone(), None)
            .await
            .unwrap()
            .is_empty()
    );
    let marker = CancellationToken::new();
    let service = NativeEffectService::with_fault_points(
        journal.clone(),
        clock(),
        Arc::new(CancelAtMarker(marker.clone())),
    );
    assert!(
        matches!(service.execute(invocation(work.clone(),adapter,marker)).await.unwrap(),
        EffectOutcome::Rejected(error) if error.code=="effect_cancelled")
    );
    let records = journal.list_for_work(work.work_id, None).await.unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].status, EffectStatus::Prepared);
    assert_eq!(records[0].dispatch_attempts, 1);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    storage.close().await.unwrap();
}

#[tokio::test]
async fn accepted_work_journal_effect_persists_null_result_and_replays_without_second_dispatch() {
    let fixture = crate::btcc::storage::tests::Fixture::activated();
    let storage = BtccStorage::open(fixture.config("effect-real-work"))
        .await
        .unwrap();
    let turns = BtccRepositories::new(storage.clone(), None);
    turns
        .load_or_admit(&crate::btcc::storage::transition_tests::prepared())
        .await
        .unwrap();
    let work = DurableWorkService::new(Arc::new(SessionWorkRepository::new(
        storage.clone(),
        clock(),
    )));
    work.start_work(StartWorkInput {
        scope: scope(),
        mutation_call_id: "start-effect".into(),
        objective: "write reviewed file".into(),
        backfill_tool_call_ids: None,
    })
    .await
    .unwrap();
    work.replace_plan(ReplacePlanInput {
        scope: scope(),
        mutation_call_id: "plan-effect".into(),
        start_new: None,
        backfill_tool_call_ids: None,
        objective: "write reviewed file".into(),
        governing_refs: None,
        execution_mode: Some(ExecutionMode::Direct),
        actions: vec![PlanAction {
            action_key: "a".into(),
            description: "write".into(),
            dependency_keys: vec![],
            effect: Some(json!({"capability":"write_file","target":"workspace:a"})),
        }],
        checks: vec!["verify".into()],
    })
    .await
    .unwrap();
    let reviewed = work
        .record_review(ReviewInput {
            scope: scope(),
            mutation_call_id: "review-effect".into(),
            subject: ReviewSubject::Plan,
            verdict: ReviewVerdict::Accept,
            summary: "accepted".into(),
            corrections: vec![],
            action_updates: None,
            correction_scope: None,
            next_stage: None,
        })
        .await
        .unwrap();
    ToolJournalRepository::new(storage.clone(), clock())
        .start(ToolJournalStart {
            turn_id: "turn".into(),
            call_id: "effect-call".into(),
            tool_name: "write_file".into(),
            raw_arguments: "{}".into(),
            arguments: json!({}),
        })
        .await
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let adapter: Arc<dyn EffectAdapter> = Arc::new(FixtureAdapter {
        calls: Arc::clone(&calls),
        result: crate::json::JsonDocument::from_value(&serde_json::Value::Null).unwrap(),
        binding: PlanBinding::AcceptedPlan,
    });
    let service = NativeEffectService::new(
        Arc::new(StorageEffectJournal::new(storage.clone(), clock())),
        clock(),
    );
    let make_input = || ExecuteEffect {
        work: reviewed.clone(),
        access: Access::Full,
        occurrence_id: Some("effect-call".into()),
        signal: CancellationToken::new(),
        target: "workspace:a".into(),
        input: json!({"path":"a","content":"x"}),
        adapter: Arc::clone(&adapter),
    };
    let EffectOutcome::Applied {
        replayed: false,
        result,
        ..
    } = service.execute(make_input()).await.unwrap()
    else {
        panic!("initial applied")
    };
    assert_eq!(result.as_str(), "null");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    storage.close().await.unwrap();
    let reopened = BtccStorage::open(fixture.config("effect-reopen"))
        .await
        .unwrap();
    let service = NativeEffectService::new(
        Arc::new(StorageEffectJournal::new(reopened.clone(), clock())),
        clock(),
    );
    let EffectOutcome::Applied {
        replayed: true,
        result,
        ..
    } = service.execute(make_input()).await.unwrap()
    else {
        panic!("replay applied")
    };
    assert_eq!(result.as_str(), "null");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    reopened.close().await.unwrap();
}
