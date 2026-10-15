//! Conversation evidence and queued schedule attribution through the public API.
use super::*;

#[tokio::test]
async fn usage_queued_schedule_and_internal_scopes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("usage-kind-evidence")?;
    fs::create_dir_all(setup.sandbox.data.join("metrics"))?;
    let now = chrono::Utc::now().timestamp_millis() - 1000;
    let mut file = fs::File::create(setup.sandbox.data.join("metrics/prompt-cache-usage.jsonl"))?;
    // More distinct turns than one query chunk; duplicate requests per turn.
    for index in 0..901 {
        for _ in 0..2 {
            writeln!(
                file,
                "{}",
                json!({"ts":now,"scope":"queued-runtime",
                "model":"m","promptTokens":10,"cachedTokens":3,
                "totalTokens":12,"turnId":format!("turn-{index}")})
            )?;
        }
    }
    for scope in [
        "cognition:run:new_chat_briefing:revision",
        "smart-search-planning",
        "dashboard-briefing",
        "unrecognized-worker",
        "app-runtime",
        "btcc-guided:deleted-chat",
    ] {
        writeln!(
            file,
            "{}",
            json!({"ts":now,"scope":scope,"model":"m",
            "promptTokens":10,"cachedTokens":3,"totalTokens":12})
        )?;
    }
    drop(file);
    let s = setup.start().await?;
    let mut db =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    db.execute_batch("INSERT INTO chats(id,title,kind,runtime_session_hint,created_at,updated_at)
        VALUES('queued-chat','Queued','chat','queued-runtime','2026-01-01','2026-01-01'),
        ('app-chat','Interactive','chat','app-runtime','2026-01-01','2026-01-01');
        INSERT INTO app_automations(id,title,prompt_body,target_kind,target_session_id,interval_seconds,state,last_run_state,created_at,updated_at)
        VALUES('a','Report','Report','chat','queued-chat',3600,'paused','delivered','2026-01-01','2026-01-01');")?;
    let tx = db.transaction()?;
    for index in 0..901 {
        let turn = format!("turn-{index}");
        let queued = format!("queue-{index}");
        tx.execute("INSERT INTO session_queued_messages(id,chat_id,text,attachments_json,controls_json,state,turn_id,created_at,updated_at)
            VALUES(?1,'queued-chat','Report','[]','{}','dispatched',?2,'2026-01-01','2026-01-01')", [&queued,&turn])?;
        tx.execute("INSERT INTO app_automation_runs(id,automation_id,target_session_id,state,trigger,started_at,queued_message_id)
            VALUES(?1,'a','queued-chat','delivered','scheduled','2026-01-01',?1)", [&queued])?;
    }
    tx.commit()?;
    let reply = s.gw.get("/usage-monitor?since_hours=24").await?;
    let top = reply.data()["topSessions"].as_array().unwrap();
    assert_eq!(top.len(), 7);
    assert_eq!(top[0]["sessionId"], "queued-chat");
    assert_eq!(top[0]["kind"], "schedule");
    assert_eq!(top[0]["requests"], 1802);
    for item in &top[1..] {
        let id = item["sessionId"].as_str().unwrap();
        let chat = matches!(id, "app-chat" | "deleted-chat");
        assert_eq!(item["kind"], if chat { "chat" } else { "butler" }, "{item}");
    }
    drop(db);
    s.finish().await
}
