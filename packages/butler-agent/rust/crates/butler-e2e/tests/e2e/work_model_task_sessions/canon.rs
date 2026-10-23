//! A person's request starts an unstarted canon Work in its home conversation.
use super::*;
pub(super) const REQUEST: &str = "Prepare another artifact for this project.";
#[tokio::test]
async fn home_request_starts_an_unstarted_canon_task_in_its_own_session() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (mut s, script, server) = start("WMU-CANON-START").await?;
    let project =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Artifacts"}),
        )
        .await?;
    let project = project.data()["project"]["id"].as_str().unwrap().to_owned();
    let chat =
        s.gw.post(
            "/sessions",
            json!({"kind":"chat","title":"Project artifacts"}),
        )
        .await?;
    let hint = chat.data()["session"]["session_hint"]
        .as_str()
        .unwrap()
        .to_owned();
    let chat = chat.data()["session"]["id"].as_str().unwrap().to_owned();
    super::super::work_model_cutover::completed(&s).await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    tokio::task::spawn_blocking(move || -> rusqlite::Result<()> {
        let db=rusqlite::Connection::open(path)?;
        let seed=include_str!("../../../fixtures/work-model-p14/seed.sql")
            .replace("'butler'",&format!("'{project}'"))
            .replace("'chat_canon'",&format!("'{hint}'"));
        db.execute_batch(&seed)?;
        db.execute_batch("DELETE FROM wm_task_edges; UPDATE wm_attempts SET status='interrupted'; UPDATE wm_tasks SET status='cancelled',chain_id=NULL,step_index=NULL,stack_position=NULL,hold_reason=NULL,held_by_task_id=NULL,failure_reason=NULL; UPDATE wm_task_chains SET state='done'; UPDATE wm_works SET run_state='idle',started_at=NULL WHERE id='wk_canon';")?;
        Ok(())
    }).await.unwrap()?;
    s.restart().await?;
    s.turn(&chat, REQUEST).await?;
    tokio::time::timeout(Duration::from_secs(30), script.child_ready.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    let rows = tasks_for(&s, &chat).await?;
    let task = rows.iter().find(|t| t["title"] == "New artifact").unwrap();
    assert_eq!(task["status"], "running");
    assert_ne!(task["assignee_session_id"], chat);
    assert_eq!(app_rows(&s).await?.len(), 1);
    let started = super::super::work_model_live::database(&s, |db| {
        db.query_row(
            "SELECT started_at FROM wm_works WHERE id='wk_canon'",
            [],
            |r| r.get::<_, Option<i64>>(0),
        )
    })
    .await?;
    assert!(started.is_some());
    script.release.add_permits(4);
    s.finish().await?;
    server.abort();
    Ok(())
}
