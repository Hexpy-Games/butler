//! Existing persisted draft-plan fixture; decisions and later replies use public ingress.
use super::*;
use rusqlite::params;

#[tokio::test]
async fn pa_04_draft_plan_accept_and_later_reply_remove_the_projection() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, _, server) = setup("PA-04").await?;
    let reply =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Plan review"}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let project = reply.data()["project"]["id"].as_str().unwrap();
    for (index, accept) in [true, false].into_iter().enumerate() {
        let reply =
            s.gw.post(
                "/sessions",
                json!({"kind":"project","title":"Draft plan","project_id":project}),
            )
            .await?;
        assert_eq!(reply.status, 201, "{}", reply.text);
        let chat = reply.data()["session"]["id"].as_str().unwrap().to_owned();
        let (_, turn) = s.turn(&chat, "Show the saved draft.").await?;
        assert_eq!(turn_state(&turn), "delivered", "{turn}");
        let data = s.sandbox.data.clone();
        let seed_chat = chat.clone();
        let plan_id = format!("PLAN-PA-{index}");
        let seed_id = plan_id.clone();
        tokio::task::spawn_blocking(move || seed(&data, &seed_chat, &seed_id))
            .await
            .map_err(|e| HarnessError(e.to_string()))??;
        let page = asks(&s, &chat).await?;
        assert_eq!(page["open_count"], 1, "{page}");
        assert_eq!(page["asks"][0]["kind"], "plan_decision");
        assert_fields(&s, &chat, &page["asks"][0], false, None).await?;
        attention(&s, &chat, false).await?;
        let live = LiveEvents::subscribe(&s.gw, 0).await?;
        if accept {
            let reply =
                s.gw.post(
                    &format!("/sessions/{chat}/plan-decisions/{plan_id}"),
                    json!({"action":"accept"}),
                )
                .await?;
            assert_eq!(reply.status, 200, "{}", reply.text);
            event(&live, &page["asks"][0]["ask_id"], "answered").await?;
        } else {
            let (_, turn) = s
                .turn(&chat, "The next reply supersedes the saved draft.")
                .await?;
            assert_eq!(turn_state(&turn), "delivered", "{turn}");
            event(&live, &page["asks"][0]["ask_id"], "superseded").await?;
        }
        assert_eq!(asks(&s, &chat).await?["open_count"], 0);
    }
    server.abort();
    s.finish().await
}

fn seed(data: &std::path::Path, chat: &str, id: &str) -> Result<(), HarnessError> {
    let db = butler_platform::sqlite::open(data.join("app-server/butler-client.sqlite"))?;
    let ledger: String=db.query_row("SELECT p.ledger_project_id FROM chats c JOIN projects p ON p.id=c.project_id WHERE c.id=?1",[chat],|r|r.get(0))?;
    let root = data.join("project-ledger/projects").join(&ledger);
    std::fs::create_dir_all(root.join("plans"))?;
    std::fs::write(root.join("project.json"),json!({"schema":"project-ledger.project.v1","id":ledger,"name":"Plan review","status":"active"}).to_string())?;
    if !root.join("ledger.jsonl").exists() {
        std::fs::write(root.join("ledger.jsonl"), "")?;
    }
    std::fs::write(
        root.join("plans").join(format!("{}.md", id.to_lowercase())),
        format!(
            "---\nschema: \"project-ledger.plan.v1\"\nkind: \"plan\"\nid: \"{id}\"\ntitle: \"Review the draft\"\nstatus: \"draft\"\n---\n\nImplement and verify the requested work.\n"
        ),
    )?;
    let message: String = db.query_row(
        "SELECT id FROM messages WHERE chat_id=?1 AND role='assistant' ORDER BY rowid DESC LIMIT 1",
        [chat],
        |r| r.get(0),
    )?;
    let plan = json!({"kind":"plan","id":id,"title":"Review the draft","status":"draft","body":"Implement and verify the requested work."});
    db.execute(
        "UPDATE messages SET plan_json=?2 WHERE id=?1",
        params![message, plan.to_string()],
    )?;
    db.execute("INSERT INTO app_open_plan_decisions(chat_id,plan_id,message_id,created_at) SELECT ?1,?2,id,created_at FROM messages WHERE id=?3",params![chat,id,message])?;
    Ok(())
}
