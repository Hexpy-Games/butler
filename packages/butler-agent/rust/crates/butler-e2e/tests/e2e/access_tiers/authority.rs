//! Shared assertions for permission-tier and Linux approval scenarios.
use butler_e2e::e2e::{HarnessError, gateway::turn_state, scenario::Scenario};
use serde_json::json;
use std::time::Duration;

pub(in super::super) async fn paused(
    s: &Scenario,
    chat: &str,
    prompt: &str,
) -> Result<String, HarnessError> {
    let id = s.gw.say_turn(chat, prompt).await?;
    let turn =
        s.gw.wait_turn(
            chat,
            &id,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(20),
        )
        .await?;
    assert_eq!(
        turn_state(&turn),
        "waiting_for_form",
        "{turn}\n{}",
        s.agent.logs()
    );
    Ok(id)
}
pub(in super::super) async fn approve(
    s: &Scenario,
    chat: &str,
    action: &str,
) -> Result<(), HarnessError> {
    for card in s.gw.approval_requests(chat).await? {
        let reference = card["request_ref"].as_str().unwrap();
        let reply =
            s.gw.post(
                &format!("/authority-requests/{reference}/{action}?session_id={chat}"),
                json!({"scope":"once"}),
            )
            .await?;
        assert_eq!(reply.status, 202, "{reply:?}");
    }
    Ok(())
}
pub(in super::super) async fn delivered(
    s: &Scenario,
    chat: &str,
    id: &str,
) -> Result<(), HarnessError> {
    let turn =
        s.gw.wait_terminal(chat, id, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}\n{}", s.agent.logs());
    Ok(())
}
pub(in super::super) fn assert_counts(
    s: &Scenario,
    id: &str,
    total: u64,
    pending: u64,
) -> Result<(), HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let counts: (u64,u64) = db.query_row("SELECT count(*),coalesce(sum(decision='pending'),0) FROM btcc_authority_requests WHERE source_turn_id=?1", [id], |row| Ok((row.get(0)?,row.get(1)?)))?;
    assert_eq!(counts, (total, pending));
    Ok(())
}
