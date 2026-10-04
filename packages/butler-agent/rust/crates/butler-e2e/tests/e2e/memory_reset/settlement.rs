//! An external writer must not strand a committed reset's completion receipt.
use super::{graph, support};
use butler_e2e::e2e::HarnessError;
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn committed_reset_settles_after_external_writer_releases() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = support::setup("MEM-RESET-SETTLEMENT").await?;
    s.agent
        .launch
        .set_env("BUTLER_E2E_RESET_SETTLEMENT_GATE", "1");
    s.restart().await?;
    let state = s.sandbox.data.join("state");
    let arm = state.join("reset-settlement-arm");
    std::fs::write(&arm, b"hold the receipt after cutover")?;
    let inventory = s.gw.post("/memory/inventory/check", json!({})).await?;
    assert_eq!(inventory.status, 200, "{}", inventory.text);
    let id = uuid::Uuid::new_v4().to_string();
    let accepted =
        s.gw.post(
            "/memory/reset/chat-memory",
            json!({"operation_id":id,"inventory_revision":inventory.data()["revision"]}),
        )
        .await?;
    assert_eq!(accepted.status, 202, "{}", accepted.text);
    tokio::time::timeout(Duration::from_secs(90), async {
        while !state.join("reset-settlement-reached").exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("reset did not reach its committed cutover");
    assert_eq!(
        graph(&s.sandbox.data)
            .parent()
            .unwrap()
            .file_name()
            .unwrap(),
        id.as_str()
    );
    let lease = butler_platform::sqlite::open(
        s.sandbox
            .data
            .join("cognition/consolidation/locks/consolidation.lock.coord.sqlite"),
    )?;
    lease
        .execute_batch("BEGIN IMMEDIATE")
        .expect("reset gate retains no writer lease");
    std::fs::remove_file(&arm)?;
    tokio::time::sleep(Duration::from_millis(150)).await;
    let waiting = s.gw.get(&format!("/memory/reset/{id}")).await?;
    assert_eq!(waiting.data()["phase"], "preparing");
    lease.execute_batch("ROLLBACK")?;
    drop(lease);
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let receipt = s.gw.get(&format!("/memory/reset/{id}")).await?;
            assert_ne!(receipt.data()["phase"], "failed", "{}", receipt.text);
            if receipt.data()["phase"] == "complete" && receipt.data()["removal_pending"] == false {
                return Ok::<(), HarnessError>(());
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("external contention stranded accepted reset settlement")?;
    let latest: serde_json::Value = serde_json::from_slice(&std::fs::read(
        s.sandbox
            .data
            .join("cognition/memory/management/reset-pending.json"),
    )?)?;
    assert_eq!(
        latest,
        json!(id),
        "latest intent references its completed receipt"
    );
    s.restart().await?;
    let replay = s.gw.get(&format!("/memory/reset/{id}")).await?;
    assert_eq!(replay.data()["phase"], "complete");
    assert_eq!(
        graph(&s.sandbox.data)
            .parent()
            .unwrap()
            .file_name()
            .unwrap(),
        id.as_str()
    );
    eprintln!(
        "MEM-RESET-SETTLEMENT committed_generation_current=true contended_receipt_settled=true removal_pending=false complete_after_restart=true"
    );
    s.finish().await
}
