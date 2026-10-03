//! Work model public-path acceptance, using the stub provider only.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]

#[path = "work_model/mod.rs"]
mod work_model;

use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup};
use serde_json::json;

#[tokio::test]
async fn wm_19_direct_has_no_managed_entities() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("WM-19")?
        .env("BUTLER_WORK_MODEL", "core")
        .stub_cassette(Cassette::load("TURN-02")?)
        .start()
        .await?;
    s.turn("general", "Reply with exactly the word: once")
        .await?;
    let reply = s.gw.get("/sessions/general/work-summary").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(reply.data()["tier"], 0);
    assert_eq!(reply.data()["total"], 0);
    assert!(reply.data()["tasks"].as_array().unwrap().is_empty());
    assert_eq!(s.provider()?.served(), 1);
    s.finish().await
}

#[tokio::test]
async fn wm_01_20_light_creation_is_atomic_and_idempotent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, instruction) = work_model::setup("WM-20").await?;
    let input = work_model::light(&instruction);
    let clock = std::time::Instant::now();
    let before = butler_platform::process_control::usage::sample(s.agent.pid().unwrap())?.unwrap();
    let first = work_model::apply(&s, input.clone()).await?;
    let after = butler_platform::process_control::usage::sample(s.agent.pid().unwrap())?.unwrap();
    eprintln!(
        "WM-20 one brief publication+activation {:?} process_write_chars={} process_write_bytes={}",
        clock.elapsed(),
        after.write_chars.unwrap() - before.write_chars.unwrap(),
        after.write_bytes - before.write_bytes
    );
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(work_model::apply(&s, input.clone()).await?, first);
    let view = work_model::summary(&s).await?;
    assert_eq!(view["tier"], 1);
    assert_eq!(view["spec_count"], 1);
    assert_eq!(view["total"], 3);
    assert_eq!(view["counts"]["pending"], 3);
    let mut conflict = input;
    conflict["command"]["goal"] = json!("different goal");
    assert_eq!(
        work_model::apply(&s, conflict).await?["error"]["code"],
        "idempotency_conflict"
    );
    assert_eq!(work_model::summary(&s).await?, view);
    s.restart().await?;
    assert_eq!(work_model::summary(&s).await?, view);
    s.finish().await
}

#[tokio::test]
async fn wm_09_15_join_requires_complete_criterion_review() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    work_model::review_and_join().await
}

#[tokio::test]
async fn wm_01_14_recursive_creation_rejects_bad_bindings_and_dags() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    work_model::invalid_creation().await
}

#[path = "work_model/recursive.rs"]
mod recursive;

#[tokio::test]
async fn wm_01_08_14_immutable_publication_before_recursive_activation() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    recursive::publication().await
}

#[path = "work_model/routing.rs"]
mod routing;

#[tokio::test]
async fn wm_19_static_surface_does_not_grow() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    routing::direct_budget().await
}

#[tokio::test]
async fn wm_20_model_bootstraps_in_one_write_without_approval() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    routing::light_tool().await
}

#[tokio::test]
async fn wm_19_direct_effect_uses_existing_journal_without_work() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    routing::direct_effect().await
}

#[path = "work_model/scale.rs"]
mod scale;
#[tokio::test]
async fn wm_13_core_owner_scale_complete_reads_and_mutations() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    scale::run().await
}

#[tokio::test]
async fn wm_13_published_spec_activation_at_owner_scale() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    scale::activation_budget().await
}

#[path = "work_model/delegation.rs"]
mod delegation;
#[tokio::test]
async fn wm_22_tier_floor_and_canonical_initial_assignment() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    delegation::initial().await
}

#[path = "work_model/acceptance.rs"]
mod acceptance;
#[tokio::test]
async fn wm_09_sparse_remove_rewiring_preserves_tombstones() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    acceptance::sparse_graph().await
}
#[tokio::test]
async fn wm_15_research_null_result_review_preserves_unproved_coverage() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    acceptance::research_review().await
}
#[tokio::test]
async fn wm_08_restart_recovers_publication_before_activation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    acceptance::publication_recovery().await
}
#[tokio::test]
async fn wm_empty_opt_in_and_writer_epoch_fences() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    acceptance::opt_in_fence().await
}
#[tokio::test]
async fn wm_22_misclassified_direct_and_light_delegation_is_held() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    routing::tier_floor().await
}
#[tokio::test]
async fn wm_managed_effect_requires_running_pinned_task() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    routing::task_effect().await
}
#[path = "work_model/nested.rs"]
mod nested;
#[tokio::test]
async fn wm_22_nested_workers_keep_one_canonical_task_and_plan() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    nested::chain().await
}

#[tokio::test]
async fn wm_core_idle_dispatch_wakes_for_external_file_producer() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, _) = work_model::setup("WM-CORE-NATIVE-WAKE").await?;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let before = s.gw.get("/sessions/general/work-model-metrics").await?;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let after = s.gw.get("/sessions/general/work-model-metrics").await?;
    assert_eq!(after.data(), before.data(), "idle queue/storage polling");
    let record = json!({"version":1,"queueId":"external",
        "envelope":{"eventId":"external","transport":"unsupported","accountId":"test",
        "peer":{},"message":{"id":"external","text":"preserve external input","timestamp":"2026-10-03T00:00:00Z"}},
        "enqueuedAt":"2026-10-03T00:00:00Z","attempts":0,"metadata":{}});
    let temporary = s.sandbox.root.join("external.tmp");
    std::fs::write(&temporary, serde_json::to_vec(&record)?)?;
    let root = s.sandbox.data.join("runtime/inbound-events");
    std::fs::rename(temporary, root.join("pending/external.json"))?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    let failed = root.join("failed/external.json");
    while !failed.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "external file admission was stranded"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    let preserved: serde_json::Value = serde_json::from_slice(&std::fs::read(failed)?)?;
    assert_eq!(
        preserved["envelope"]["message"]["text"],
        record["envelope"]["message"]["text"]
    );
    assert_eq!(work_model::summary(&s).await?["tier"], 0);
    s.finish().await
}

#[tokio::test]
async fn wm_15_recursive_coverage_requires_children_and_integration() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    coverage::run().await
}

#[path = "work_model/coverage.rs"]
mod coverage;
