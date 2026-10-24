//! A vector lane returning past recall's deadline keeps the text lanes' reserve.
use super::{ASK, assert_saved_instruction, batch, memory_stubs, recall_budget};
use butler_e2e::e2e::HarnessError;
use std::time::{Duration, Instant};

#[tokio::test]
async fn late_vector_lane_keeps_text_reserve() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (setup, remember, code) = batch::setup("MEM-LANE-OVERRUN")?;
    let release = setup.sandbox.root.join("lane-release");
    let s = setup
        .env("BUTLER_MEMORY_SYNC_TRACE", "1")
        .env("BUTLER_E2E_HOLD_POINT", "memory_recall_vector_lane")
        .env("BUTLER_E2E_HOLD_RELEASE", release.to_string_lossy())
        .start()
        .await?;
    assert_eq!(s.turn("general", &remember).await?.1["state"], "delivered");
    memory_stubs::text_complete(&s.sandbox.data, 1).await?;
    let held = release.with_extension("held");
    let release_after_deadline = async {
        tokio::time::timeout(Duration::from_secs(30), async {
            while !held.exists() {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("recall must reach its vector lane");
        // The recall started before its lane held, so its whole deadline,
        // text reserve included, has passed when the lane returns.
        let total = Duration::from_millis(recall_budget::TOTAL_MS.try_into().unwrap());
        tokio::time::sleep_until((Instant::now() + total).into()).await;
        std::fs::write(&release, b"")?;
        Ok::<_, HarnessError>(())
    };
    let (recalled, ()) =
        tokio::try_join!(batch::recall(&s, "general", ASK), release_after_deadline)?;
    assert_eq!(
        recalled["output"]["coverage"]["graph"]["state"], "ok",
        "{recalled}"
    );
    assert_saved_instruction(&recalled, &code, 1);
    eprintln!(
        "LANE-OVERRUN held_ms>={} text_complete=true",
        recall_budget::TOTAL_MS
    );
    s.finish().await
}
