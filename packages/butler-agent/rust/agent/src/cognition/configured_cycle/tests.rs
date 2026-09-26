
use super::*;

struct PhaseFixture;
impl ConfiguredPhaseExecutor for PhaseFixture {
    fn run<'a>(
        &'a self,
        phase: ConfiguredPhase,
        _: i64,
        _: &'a CancellationToken,
    ) -> ConfiguredPhaseFuture<'a> {
        Box::pin(async move {
            if phase == ConfiguredPhase::Consolidate {
                Err(CognitionError::new(
                    "fixture_consolidate_failed",
                    "fixture_consolidate_failed",
                ))
            } else {
                Ok(json!({"phase_effect":phase.name()}))
            }
        })
    }
}

#[tokio::test]
async fn missing_generation_skips_and_phase_failure_remains_in_daily_report() {
    let root =
        std::env::temp_dir().join(format!("butler-configured-cycle-{}", uuid::Uuid::new_v4()));
    let paths = CognitionPathEnvironment::default();
    let service = ConfiguredCycleService::new(root.clone(), paths.clone(), Arc::new(PhaseFixture));
    let options = ConfiguredCycleOptions::load(&root);
    let cancel = CancellationToken::new();
    let skipped = service
        .run(&options, &cancel)
        .await
        .expect("skip absent generation");
    assert!(skipped.skipped);
    assert_eq!(skipped.phases_run, 0);
    assert!(
        !root
            .join("cognition/consolidation/run-summary.jsonl")
            .exists()
    );
    let memory = paths.memory_root(&root);
    std::fs::create_dir_all(&memory).expect("create memory root");
    std::fs::write(memory.join("active-generation.json"), b"{}").expect("mark descriptor present");
    let completed = service
        .run(&options, &cancel)
        .await
        .expect("report phase failure");
    assert_eq!(completed.exit_code, 0);
    assert_eq!(completed.phases_run, 3);
    assert_eq!(completed.failed_phases, ["consolidate"]);
    let summary = std::fs::read_to_string(root.join("cognition/consolidation/run-summary.jsonl"))
        .expect("read summary");
    assert_eq!(
        serde_json::from_str::<Value>(summary.lines().next().unwrap()).unwrap()["status"],
        "error"
    );
    std::fs::remove_dir_all(root).expect("remove isolated fixture");
}

struct CancelsOnFirstPhase;

impl ConfiguredPhaseExecutor for CancelsOnFirstPhase {
    fn run<'a>(
        &'a self,
        phase: ConfiguredPhase,
        _deadline_at_epoch_ms: i64,
        cancellation: &'a CancellationToken,
    ) -> ConfiguredPhaseFuture<'a> {
        Box::pin(async move {
            assert_eq!(phase, ConfiguredPhase::Catchup);
            cancellation.cancel();
            Ok(json!({"completed_before_cancel":true}))
        })
    }
}

#[tokio::test]
async fn cancellation_after_phase_blocks_next_admission() {
    let root =
        std::env::temp_dir().join(format!("butler-configured-cancel-{}", uuid::Uuid::new_v4()));
    let paths = CognitionPathEnvironment::default();
    let memory = paths.memory_root(&root);
    std::fs::create_dir_all(&memory).unwrap();
    std::fs::write(memory.join("active-generation.json"), b"{}").unwrap();
    let service = ConfiguredCycleService::new(root.clone(), paths, Arc::new(CancelsOnFirstPhase));
    let result = service
        .run(
            &ConfiguredCycleOptions::load(&root),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result.aborted, Some("cancelled"));
    assert_eq!(result.exit_code, 1);
    assert_eq!(result.phases_run, 1);
    std::fs::remove_dir_all(root).unwrap();
}
