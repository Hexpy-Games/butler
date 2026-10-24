//! A reset started right after launch finishes while another writer holds the lease.

// This scenario requires hooks compiled into the target executable.
mod requires_e2e_fixtures {
    use super::super::support;
    use butler_e2e::e2e::HarnessError;
    use serde_json::json;
    use std::time::Duration;

    #[tokio::test]
    async fn reset_memory_right_after_launch_completes() -> Result<(), HarnessError> {
        butler_e2e::gate!();
        let mut s = support::setup("MEM-RESET-AFTER-LAUNCH").await?;
        // Launch runs its startup consolidation cycle; the user resets right after.
        support::cycle(&mut s).await?;
        let state = s.sandbox.data.join("state");
        let inventory = s.gw.post("/memory/inventory/check", json!({})).await?;
        assert_eq!(inventory.status, 200, "{}", inventory.text);
        let id = uuid::Uuid::new_v4().to_string();
        // Another memory writer takes the lease just before the receipt is stored.
        std::fs::write(state.join("reset-receipt-hold-arm"), &id)?;
        let accepted =
            s.gw.post(
                "/memory/reset/profile",
                json!({"operation_id":id,"inventory_revision":inventory.data()["revision"]}),
            )
            .await?;
        assert_eq!(accepted.status, 202, "{}", accepted.text);
        tokio::time::timeout(Duration::from_secs(90), async {
            while !state.join("reset-receipt-hold-reached").exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("reset did not reach its receipt while the lease was held");
        let held = s.gw.get(&format!("/memory/reset/{id}")).await?;
        assert_eq!(held.data()["phase"], "preparing", "{}", held.text);
        std::fs::write(state.join("reset-receipt-hold-release"), &id)?;
        let mut last = serde_json::Value::Null;
        tokio::time::timeout(Duration::from_secs(90), async {
            loop {
                let receipt = s.gw.get(&format!("/memory/reset/{id}")).await?;
                last = receipt.data().clone();
                assert_ne!(last["phase"], "failed", "{}", receipt.text);
                if last["phase"] == "complete" {
                    return Ok::<(), HarnessError>(());
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("reset stayed in progress after the writer released: {last}"))?;
        s.restart().await?;
        let replay = s.gw.get(&format!("/memory/reset/{id}")).await?;
        assert_eq!(replay.data()["phase"], "complete", "{}", replay.text);
        s.finish().await
    }
}
