use super::*;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::coordination::{CognitionProcessStatus, CoordinationResult};

struct TestHost;

impl CognitionCoordinationHost for TestHost {
    fn process_id(&self) -> u32 {
        std::process::id()
    }
    fn hostname(&self) -> CoordinationResult<String> {
        Ok("test-host".into())
    }
    fn process_status(&self, pid: u64) -> CognitionProcessStatus {
        if pid == u64::from(std::process::id()) {
            CognitionProcessStatus::Alive
        } else {
            CognitionProcessStatus::DefinitelyDead
        }
    }
    fn new_uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn now_epoch_millis(&self) -> i64 {
        1_790_118_000_000
    }
    fn now_iso(&self) -> String {
        "2026-09-23T00:00:00.000Z".into()
    }
}

struct TestPhases {
    calls: Mutex<Vec<Phase>>,
    resolve_feedback: AtomicBool,
    block_feedback: AtomicBool,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

impl TestPhases {
    fn new() -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            resolve_feedback: AtomicBool::new(false),
            block_feedback: AtomicBool::new(false),
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        }
    }
}

impl PhaseExecutor for TestPhases {
    fn execute<'a>(
        &'a self,
        phase: Phase,
        _run_id: &'a str,
        _cancellation: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<Map<String, Value>, PhaseError>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.lock().push(phase);
            if phase == Phase::FeedbackTriage && self.block_feedback.load(Ordering::SeqCst) {
                self.entered.notify_one();
                self.release.notified().await;
            }
            if phase == Phase::Preflight
                || phase == Phase::MetricsSummary
                || (phase == Phase::FeedbackTriage && self.resolve_feedback.load(Ordering::SeqCst))
            {
                Ok(Map::new())
            } else {
                Err(PhaseError::unavailable(phase))
            }
        })
    }
}

struct TestEvents;
impl CycleEventSink for TestEvents {
    fn record(&self, _: &str, _: &str, _: Value) {}
}

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "butler-cycle-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        )))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn service(root: &Scratch, phases: Arc<TestPhases>) -> CycleService {
    let host = Arc::new(TestHost);
    let coordinator = Arc::new(CognitionWriteCoordinator::new(host.clone()).unwrap());
    CycleService::new(
        root.0.clone(),
        CognitionPathEnvironment::default(),
        coordinator,
        host,
        phases,
        Arc::new(TestEvents),
    )
}

/// Race: a consolidation resume racing an active claim sees the claim without
/// holding the writer lease.
// test-category: race
#[tokio::test]
async fn concurrent_resume_sees_active_claim_without_holding_the_writer_lease() {
    let root = Scratch::new();
    let phases = Arc::new(TestPhases::new());
    phases.block_feedback.store(true, Ordering::SeqCst);
    let service = Arc::new(service(&root, phases.clone()));
    let first_service = service.clone();
    let first = tokio::spawn(async move {
        first_service
            .run(RunCycle {
                run_id: Some("cr_claim".into()),
                ..RunCycle::default()
            })
            .await
    });
    phases.entered.notified().await;
    let second = service
        .run(RunCycle {
            run_id: Some("cr_claim".into()),
            resume: true,
            ..RunCycle::default()
        })
        .await
        .unwrap();
    assert_eq!(second.status, CycleStatus::LockHeld);
    assert_eq!(second.phases[0].phase, Phase::FeedbackTriage);
    phases.release.notify_one();
    assert_eq!(
        first.await.unwrap().unwrap().status,
        CycleStatus::CompletedWithErrors
    );
}
