//! Conversation evidence and queued schedule attribution through the public API.
use super::*;

#[tokio::test]
async fn usage_queued_schedule_and_internal_scopes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("usage-kind-evidence")?;
    fs::create_dir_all(setup.sandbox.data.join("metrics"))?;
    let now = chrono::Utc::now().timestamp_millis() - 1000;
    let mut file = fs::File::create(setup.sandbox.data.join("metrics/prompt-cache-usage.jsonl"))?;
    // Many queued turns, with duplicate requests per turn.
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
            VALUES(?1,'a','queued-chat','delivered','scheduled',?2,?1)", [&queued, &chrono::DateTime::from_timestamp_millis(now-1000).unwrap().to_rfc3339()])?;
    }
    tx.commit()?;
    // Dispatch completed before the window, but this turn still produced usage.
    db.execute(
        "UPDATE app_automation_runs SET completed_at='2026-01-01' WHERE id='queue-900'",
        [],
    )?;
    let reply = s.gw.get("/usage-monitor?since_hours=24").await?;
    assert_eq!(reply.data()["topSessions"][0]["kind"], "schedule");
    // Updating the dispatch timestamp must preserve the same attribution.
    let stamp = chrono::DateTime::from_timestamp_millis(now - 1000)
        .unwrap()
        .with_timezone(&chrono::FixedOffset::east_opt(9 * 3600).unwrap())
        .to_rfc3339();
    db.execute(
        "UPDATE app_automation_runs SET completed_at=?1 WHERE id='queue-900'",
        [stamp],
    )?;
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

/// Both durable turn bindings survive a run starting before the usage window.
#[tokio::test]
async fn usage_schedule_run_overlaps_window() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("usage-schedule-window")?;
    fs::create_dir_all(setup.sandbox.data.join("metrics"))?;
    let now = chrono::Utc::now();
    let mut log = fs::File::create(setup.sandbox.data.join("metrics/prompt-cache-usage.jsonl"))?;
    for scope in ["bound-runtime", "unbound-runtime"] {
        writeln!(
            log,
            "{}",
            json!({"ts":now.timestamp_millis()-1000,"scope":scope,
            "model":"m","promptTokens":10,"cachedTokens":3,"totalTokens":12,
            "turnId":scope})
        )?;
    }
    drop(log);
    let s = setup.start().await?;
    let db = butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    db.execute_batch("INSERT INTO chats(id,title,kind,runtime_session_hint,created_at,updated_at)
        VALUES('bound-chat','Report','chat','bound-runtime','2026-01-01','2026-01-01');
        INSERT INTO app_automations(id,title,prompt_body,target_kind,target_session_id,interval_seconds,state,last_run_state,created_at,updated_at)
        VALUES('a','Report','Report','chat','bound-chat',3600,'paused','delivered','2026-01-01','2026-01-01');
        INSERT INTO session_queued_messages(id,chat_id,text,attachments_json,controls_json,state,turn_id,created_at,updated_at)
        VALUES('q','bound-chat','Report','[]','{}','dispatched','bound-runtime','2026-01-01','2026-01-01');")?;
    let started = (now - chrono::Duration::hours(25)).to_rfc3339();
    db.execute("INSERT INTO app_automation_runs(id,automation_id,target_session_id,state,trigger,started_at,queued_message_id,turn_id)
        VALUES('queued','a','bound-chat','queued','scheduled',?1,'q',NULL),
              ('direct','a','bound-chat','running','scheduled',?1,NULL,'unbound-runtime')", [&started])?;
    // Cover pending runs and completed runs with a non-UTC timestamp offset.
    let completed = now
        .with_timezone(&chrono::FixedOffset::east_opt(9 * 3600).unwrap())
        .to_rfc3339();
    for completion in [None, Some(completed.as_str()), Some(started.as_str())] {
        db.execute(
            "UPDATE app_automation_runs SET completed_at=?1",
            [completion],
        )?;
        let reply = s.gw.get("/usage-monitor?since_hours=24").await?;
        let entries = reply.data()["topSessions"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(reply.data()["model"]["requestCount"], 2);
        assert_timeline(reply.data());
        for entry in entries {
            assert_eq!(entry["kind"], "schedule", "{entry}");
            assert_eq!(entry["requests"], 1);
            assert_eq!(entry["totalTokens"], 12.0);
        }
        assert!(
            entries
                .iter()
                .any(|entry| entry["sessionId"] == "bound-chat")
        );
        assert!(
            entries
                .iter()
                .any(|entry| entry["sessionId"] == "unbound-runtime")
        );
    }
    // All time counts both turns even though their runs started before 24h.
    let reply = s.gw.get("/usage-monitor").await?;
    assert_eq!(reply.data()["model"]["requestCount"], 2);
    assert_eq!(reply.data()["model"]["totalTokens"], 24.0);
    drop(db);
    s.finish().await
}
