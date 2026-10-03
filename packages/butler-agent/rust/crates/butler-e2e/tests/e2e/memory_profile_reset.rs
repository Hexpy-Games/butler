//! Profile App reset and recovery of the gap after the owner transaction commits.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use butler_platform::sqlite;
use rusqlite::OpenFlags;
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
#[path = "support/memory_reset_support.rs"]
mod support;
fn count(path: &Path) -> i64 {
    sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM stable_profile_entries", [], |row| {
            row.get(0)
        })
        .unwrap()
}
async fn wait(s: &Scenario, id: &str) -> Result<(), HarnessError> {
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let reply = s.gw.get(&format!("/memory/reset/{id}")).await?;
            assert_ne!(reply.data()["phase"], "failed", "{}", reply.text);
            if reply.data()["phase"] == "complete" {
                return Ok(());
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("profile reset receipt")
}
#[tokio::test]
async fn profile_reset_preserves_names_consent_settings_and_replay_preserves_future_content()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (base, server) = support::profile_server().await?;
    let mut s = support::setup("MEM-PROFILE-RESET-APP").await?;
    support::local_model(&s, &base).await?;
    let configured = s.gw.patch("/personalization",json!({"profile":{"principal_name":"Mina", "butler_nickname":"Butler", "preferred_address":"Mina"},"profiling":{"mode":"basic"}})).await?;
    assert_eq!(configured.status, 200, "{}", configured.text);
    let personal = s.gw.get("/personalization").await?.data().clone();
    assert_eq!(personal["profile"]["principal_name"], "Mina");
    assert_eq!(
        s.turn("general", "I prefer concise answers.").await?.1["state"],
        "delivered"
    );
    support::cycle(&mut s).await?;
    let db = s.sandbox.data.join("cognition/profile/profile.sqlite");
    assert!(count(&db) > 0);
    let checked = s.gw.post("/memory/inventory/check", json!({})).await?;
    assert_eq!(checked.status, 200, "{}", checked.text);
    let id = uuid::Uuid::new_v4().to_string();
    let input = json!({"operation_id":id,"inventory_revision":checked.data()["revision"]});
    let accepted = s.gw.post("/memory/reset/profile", input.clone()).await?;
    assert_eq!(accepted.status, 202, "{}", accepted.text);
    wait(&s, &id).await?;
    assert_eq!(count(&db), 0);
    let after = s.gw.get("/personalization").await?.data().clone();
    assert_eq!(
        after.get("profile").unwrap(),
        personal.get("profile").unwrap()
    );
    assert_eq!(
        after.get("profiling").unwrap(),
        personal.get("profiling").unwrap()
    );
    support::cycle(&mut s).await?;
    assert_eq!(count(&db), 0);
    assert_eq!(
        s.turn("general", "I prefer concise answers in future chats too.")
            .await?
            .1["state"],
        "delivered"
    );
    support::cycle(&mut s).await?;
    assert!(count(&db) > 0);
    let future = count(&db);
    assert_eq!(
        s.gw.post("/memory/reset/profile", input).await?.data()["phase"],
        "complete"
    );
    assert_eq!(count(&db), future);
    s.agent.terminate().await?;
    // Durable state at the crash boundary: the profile transaction committed,
    // but its common operation receipt has not yet been completed.
    let receipt = s
        .sandbox
        .data
        .join("cognition/memory/management/resets")
        .join(&id)
        .join("receipt.json");
    let mut saved: Value = serde_json::from_slice(&std::fs::read(&receipt)?)?;
    saved["phase"] = json!("preparing");
    std::fs::write(receipt, saved.to_string())?;
    s.gw = s.agent.start_again().await?;
    wait(&s, &id).await?;
    assert_eq!(
        count(&db),
        future,
        "recovery cleared post-reset profile content"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
