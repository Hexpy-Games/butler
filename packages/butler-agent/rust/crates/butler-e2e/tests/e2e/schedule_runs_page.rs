#![allow(clippy::expect_used, reason = "E2E assertions")]

use butler_e2e::e2e::{HarnessError, scenario::Setup};
use butler_platform::sqlite;
use rusqlite::params;
use serde_json::json;

#[tokio::test]
async fn sched_runs_page_cursor_walks_newest_first() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SCHED-RUNS-PAGE")?.start().await?;
    let created =
        s.gw.post(
            "/automations",
            json!({
                "title": "Paged",
                "prompt_body": "Summarize my day.",
                "target_session_id": "general",
                "interval_seconds": 3600,
            }),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["automation"]["id"]
        .as_str()
        .expect(&created.text);

    s.agent.terminate().await?;
    let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    for i in 1..=5 {
        let started_at = format!("2026-01-01T00:00:0{i}Z");
        db.execute(
            "INSERT INTO app_automation_runs \
             (id,automation_id,target_session_id,state,trigger,started_at,completed_at) \
             VALUES (?1,?2,'general','succeeded','manual',?3,?3)",
            params![format!("page-run-{i}"), id, started_at],
        )?;
    }
    drop(db);
    s.gw = s.agent.start_again().await?;

    for (query, expected_ids, next) in [
        (
            "?limit=2",
            &["page-run-5", "page-run-4"][..],
            Some("page-run-4"),
        ),
        (
            "?limit=2&cursor=page-run-4",
            &["page-run-3", "page-run-2"][..],
            Some("page-run-2"),
        ),
        ("?limit=2&cursor=page-run-2", &["page-run-1"][..], None),
        (
            "",
            &[
                "page-run-5",
                "page-run-4",
                "page-run-3",
                "page-run-2",
                "page-run-1",
            ][..],
            None,
        ),
    ] {
        let reply = s.gw.get(&format!("/automations/{id}/runs{query}")).await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        let ids: Vec<_> = reply.data()["runs"]
            .as_array()
            .expect(&reply.text)
            .iter()
            .map(|run| run["id"].as_str().expect(&reply.text))
            .collect();
        assert_eq!(ids, expected_ids, "{}", reply.text);
        assert_eq!(
            reply.data().get("next_cursor"),
            next.map(|id| json!(id)).as_ref(),
            "{}",
            reply.text
        );
    }
    s.finish().await
}
