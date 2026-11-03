//! Unrelated chats and unattended schedules retain their own authority.
use super::*;
use std::time::{Duration, Instant};

#[tokio::test]
async fn another_conversation_and_schedule_keep_their_modes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup().await?;
    let created =
        s.gw.post(
            "/sessions",
            json!({"kind":"chat","title":"Other conversation"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let other = created.data()["session"]["id"].as_str().unwrap();
    script
        .rounds
        .lock()
        .unwrap()
        .insert("Other status".into(), vec![command("other")]);
    script
        .rounds
        .lock()
        .unwrap()
        .insert("Scheduled status".into(), vec![command("scheduled")]);
    let root = paused(&s, "general", PROMPT).await?;
    let cards = s.gw.approval_requests("general").await?;
    controls(&s, "full_access").await?;
    answer(&s, cards[0]["request_ref"].as_str().unwrap(), "allow").await?;
    delivered(&s, "general", &root).await?;
    let other_turn = paused(&s, other, "Other status").await?;
    let pending = s.gw.approval_requests(other).await?;
    assert_eq!(pending.len(), 1);
    let reference = pending[0]["request_ref"].as_str().unwrap();
    let reply =
        s.gw.post(
            &format!("/authority-requests/{reference}/deny?session_id={other}"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    delivered(&s, other, &other_turn).await?;
    scheduled(&s).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn scheduled(s: &Scenario) -> Result<(), HarnessError> {
    assert_eq!(
        s.gw.patch("/settings", json!({"plan_mode_default":true}))
            .await?
            .status,
        200
    );
    let reply =
        s.gw.post(
            "/automations",
            json!({"title":"Status","prompt_body":"Scheduled status",
        "target_session_id":"general","access_mode":"auto","schedule_type":"once",
        "run_at":"2000-01-01T00:00:00.000Z"}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let schedule = reply.data()["automation"]["id"].as_str().unwrap();
    assert_eq!(
        s.gw.post("/automations/dispatch-due", json!({}))
            .await?
            .status,
        202
    );
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let runs = s.gw.get(&format!("/automations/{schedule}/runs")).await?;
        if let Some(run) = runs.data()["runs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|run| run["safe_error_code"] == "schedule_permission_required")
        {
            let turn = run["turn_id"].as_str().unwrap();
            delivered(s, "general", turn).await?;
            assert_counts(s, turn, 0, 0)?;
            return Ok(());
        }
        assert!(
            Instant::now() < deadline,
            "schedule did not retain Auto: {}",
            runs.text
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
