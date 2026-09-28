use super::*;

/// Race: an effect journal CAS failure between intent and receipt leaves the
/// effect uncertain, and recovery backfills it through the real lane.
// test-category: race
#[tokio::test]
async fn journal_cas_failed_uncertain_and_recovery_backfill_use_real_lane() {
    let (_fixture, storage, work) = ready("effect-cas-recovery").await;
    let adapter: Arc<dyn EffectAdapter> = Arc::new(FixtureAdapter {
        calls: Arc::new(AtomicUsize::new(0)),
        result: butler_core::json::JsonDocument::from_value(&json!({"ok":true})).unwrap(),
        binding: PlanBinding::AcceptedPlan,
    });
    let journal = StorageEffectJournal::new(storage.clone(), clock());
    let make_identity = |occurrence: &str| {
        let mut input = invocation(work.clone(), Arc::clone(&adapter), CancellationToken::new());
        input.occurrence_id = Some(occurrence.into());
        super::identity::resolve(&input).unwrap().identity
    };
    let first = make_identity("first");
    let PrepareEffect::Ready {
        created: true,
        record,
    } = journal.prepare(first.clone(), None).await.unwrap()
    else {
        panic!("prepared")
    };
    let claimed = journal
        .claim_dispatch(first.effect_id.clone(), record.journal_revision)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claimed.dispatch_attempts, 1);
    assert!(
        journal
            .claim_dispatch(first.effect_id.clone(), record.journal_revision)
            .await
            .unwrap()
            .is_none()
    );
    let failed = journal
        .record_failed(
            first.effect_id.clone(),
            claimed.journal_revision,
            EffectError::new("effect_dispatch_failed", "registered rejection"),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(failed.status, EffectStatus::Failed);
    let replay = journal.prepare(first.clone(), None).await.unwrap();
    assert!(
        matches!(replay,PrepareEffect::Ready { created:false,record } if record.status==EffectStatus::Failed)
    );
    let second = make_identity("second");
    let PrepareEffect::Ready { record, .. } = journal.prepare(second.clone(), None).await.unwrap()
    else {
        panic!("second prepared")
    };
    let returned = journal
        .prepare(
            second.clone(),
            Some(RecoveryHint::Single {
                capability: "edit_file".into(),
                start_line: 2,
                before_sha256: "a".repeat(64),
                after_sha256: "b".repeat(64),
            }),
        )
        .await
        .unwrap();
    assert!(
        matches!(returned,PrepareEffect::Ready { created:false,record } if record.recovery_hint.is_none())
    );
    assert!(matches!(
        journal
            .find(second.effect_id.clone())
            .await
            .unwrap()
            .unwrap()
            .recovery_hint,
        Some(RecoveryHint::Single { start_line: 2, .. })
    ));
    let uncertain = journal
        .record_uncertain(
            second.effect_id.clone(),
            record.journal_revision,
            EffectError::new("effect_reconciliation_required", "unknown"),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(uncertain.status, EffectStatus::Uncertain);
    assert_eq!(uncertain.dispatch_attempts, 0);
    assert!(super::outcomes::evidence(&uncertain).is_none());
    storage.close().await.unwrap();
}
