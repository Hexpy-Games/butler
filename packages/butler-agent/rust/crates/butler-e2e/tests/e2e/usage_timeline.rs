//! Usage timeline and range breakdown through the public gateway.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::{Value, json};
use std::{fs, io::Write};

pub(super) fn assert_timeline(view: &Value) {
    let slots = view["timeline"]["slots"].as_array().unwrap();
    assert_eq!(view["timeline"]["slotMinutes"], 15);
    assert!(
        slots
            .windows(2)
            .all(|s| s[0][0].as_i64() < s[1][0].as_i64())
    );
    for (column, field) in [
        (1, "requestCount"),
        (2, "promptTokens"),
        (3, "cachedTokens"),
        (4, "outputTokens"),
    ] {
        let sum: f64 = slots.iter().map(|s| s[column].as_f64().unwrap()).sum();
        assert_eq!(sum, view["model"][field].as_f64().unwrap(), "{field}");
    }
    assert!(slots.iter().all(|s| s[0].as_i64().unwrap() % 900_000 == 0));
}

#[tokio::test]
async fn usage_timeline_range_breakdown() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("usage-timeline")?;
    let metrics = setup.sandbox.data.join("metrics");
    fs::create_dir_all(&metrics)?;
    let now = chrono::Utc::now().timestamp_millis();
    let mut log = fs::File::create(metrics.join("prompt-cache-usage.jsonl"))?;
    for (age, scope, model, total) in [
        (
            1000,
            "btcc-guided:butler/app-general",
            "openai/gpt-6-luna",
            1200,
        ),
        (2000, "memory-extract:revision", "custom/other", 2400),
        (
            25 * 3_600_000,
            "btcc-guided:butler/app-general",
            "openai/gpt-6-luna",
            900,
        ),
    ] {
        writeln!(
            log,
            "{}",
            json!({"ts":now-age,"model":model,"scope":scope,
            "promptTokens":600,"cachedTokens":200,"totalTokens":total})
        )?;
    }
    drop(log);
    let s = setup.start().await?;
    let db = butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))
        .unwrap();
    db.execute(
        "UPDATE chats SET title='Timeline conversation' WHERE id='general'",
        [],
    )
    .unwrap();
    let all = s.gw.get("/usage-monitor?since_hours=24").await?;
    assert_eq!(all.status, 200, "{}", all.text);
    let view = all.data();
    assert_timeline(view);
    assert_eq!(view["model"]["totalTokens"], 3600.0);
    assert_eq!(
        view["model"]["byModel"]["openai/gpt-6-luna"]["totalTokens"],
        1200.0
    );
    assert_eq!(
        view["model"]["byModel"]["custom/other"]["totalTokens"],
        2400.0
    );
    assert_eq!(view["cost"]["available"], false);
    assert_eq!(view["previousPeriod"]["totalTokens"], 900.0);
    let top = view["topSessions"].as_array().unwrap();
    assert_eq!(top.len(), 2);
    assert_eq!(top[0]["sessionId"], "memory-extract:revision");
    assert_eq!(top[0]["kind"], "butler");
    assert!(top[0]["title"].is_null());
    assert_eq!(top[1]["sessionId"], "general");
    assert_eq!(top[1]["title"], "Timeline conversation");
    assert_eq!(top[1]["kind"], "chat");
    let scoped =
        s.gw.get("/usage-monitor?since_hours=24&session_id=general")
            .await?;
    assert_timeline(scoped.data());
    assert_eq!(scoped.data()["model"]["totalTokens"], 1200.0);
    assert_eq!(scoped.data()["previousPeriod"]["totalTokens"], 900.0);
    let internal =
        s.gw.get("/usage-monitor?since_hours=24&session_id=memory-extract%3Arevision")
            .await?;
    assert_eq!(internal.status, 200, "{}", internal.text);
    assert_timeline(internal.data());
    assert_eq!(internal.data()["model"]["totalTokens"], 2400.0);
    let life = s.gw.get("/usage-monitor?session_id=general").await?;
    assert_timeline(life.data());
    assert_eq!(life.data()["model"]["totalTokens"], 2100.0);
    let empty =
        s.gw.get("/usage-monitor?since_hours=0.0000001&session_id=general")
            .await?;
    assert_eq!(empty.data()["topSessions"][0]["sessionId"], "general");
    assert_eq!(empty.data()["topSessions"][0]["requests"], 0);
    assert!(empty.data()["topSessions"][0]["lastUsedMs"].is_null());
    drop(db);
    s.finish().await
}

fn write_tools(data: &std::path::Path, name: &str, ts: i64) {
    fs::create_dir_all(data.join("transcripts")).unwrap();
    let stamp = chrono::DateTime::from_timestamp_millis(ts)
        .unwrap()
        .to_rfc3339();
    let path = data.join("transcripts").join(format!("{name}.jsonl"));
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    for (kind, ok) in [("tool_call", true), ("tool_result", false)] {
        writeln!(
            file,
            "{}",
            json!({"kind":kind,"timestamp":stamp,"payload":{"name":"read_file","ok":ok}})
        )
        .unwrap();
    }
}
#[tokio::test]
async fn usage_range_tools_and_search_are_incremental() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("usage-range-tools")?;
    let data = &setup.sandbox.data;
    let now = chrono::Utc::now().timestamp_millis();
    write_tools(data, "butler_app-general", now - 1000);
    write_tools(data, "second", now - 2000);
    write_tools(data, "second", now - 25 * 3_600_000);
    fs::create_dir_all(data.join("metrics"))?;
    let search = data.join("metrics/web-search-usage.jsonl");
    fs::write(
        &search,
        format!(
            "{}\n{}\n",
            json!({"ts":now-1000,"provider":"search"}),
            json!({"ts":now-25*3_600_000,"provider":"old"})
        ),
    )?;
    let s = setup.start().await?;
    for (suffix, calls) in [("", 2), ("&session_id=general", 1)] {
        let reply =
            s.gw.get(&format!("/usage-monitor?since_hours=24{suffix}"))
                .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        assert_eq!(reply.data()["tools"]["calls"], calls);
        assert_eq!(reply.data()["tools"]["failures"], calls);
        assert_eq!(reply.data()["tools"]["byTool"]["read_file"]["calls"], calls);
        assert_eq!(reply.data()["webSearch"]["requestCount"], 1);
    }
    write_tools(&s.sandbox.data, "second", now - 500);
    let mut file = fs::OpenOptions::new().append(true).open(&search)?;
    writeln!(
        file,
        "{}",
        json!({"ts":now-500,"provider":"new","error":"failed"})
    )?;
    drop(file);
    let reply = s.gw.get("/usage-monitor?since_hours=24").await?;
    assert_eq!(reply.data()["tools"]["calls"], 3);
    assert_eq!(reply.data()["webSearch"]["requestCount"], 2);
    assert_eq!(reply.data()["webSearch"]["lastProvider"], "new");
    assert_eq!(reply.data()["webSearch"]["lastError"], "failed");
    // Rotation resets just that file's contribution; unchanged reads do not duplicate it.
    fs::remove_file(s.sandbox.data.join("transcripts/second.jsonl"))?;
    fs::write(
        &search,
        format!("{}\n", json!({"ts":now-200,"provider":"replacement"})),
    )?;
    for _ in 0..2 {
        let reply = s.gw.get("/usage-monitor?since_hours=24").await?;
        assert_eq!(reply.data()["tools"]["calls"], 1);
        assert_eq!(reply.data()["webSearch"]["requestCount"], 1);
        assert_eq!(reply.data()["webSearch"]["lastProvider"], "replacement");
    }
    s.finish().await
}

// test-category: pure-logic
#[test]
fn usage_exact_range_boundaries_and_rotation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let directory = std::env::temp_dir().join(format!("usage-edges-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(directory.join("metrics")).unwrap();
    let monitor = butler_runtime::operations::UsageMonitor::default();
    let path = directory.join("metrics/prompt-cache-usage.jsonl");
    let since: i64 = 1_000_000;
    let until: i64 = 2_000_000;
    let mut file = fs::File::create(&path).unwrap();
    for ts in [0, since - 1, since, until - 1, until] {
        writeln!(
            file,
            "{}",
            json!({"ts":ts,"scope":"btcc-guided:s","model":"m",
            "promptTokens":10,"cachedTokens":3,"totalTokens":12})
        )
        .unwrap();
    }
    writeln!(
        file,
        "{}",
        json!({"ts":since,"scope":"s","model":"m",
        "promptTokens":20,"cachedTokens":3,"totalTokens":25})
    )?;
    drop(file);
    let mut searches = fs::File::create(directory.join("metrics/web-search-usage.jsonl"))?;
    for ts in [until, since, until - 1, since - 1] {
        writeln!(
            searches,
            "{}",
            json!({"ts":ts,"provider":format!("provider-{ts}")})
        )?;
        write_tools(&directory, "s", ts);
    }
    drop(searches);
    let view = monitor.read_at(
        &directory,
        Some("s"),
        None,
        Some(since as f64),
        until as f64,
        None,
    );
    assert_eq!(view["tools"]["calls"], 2);
    assert_eq!(view["tools"]["failures"], 2);
    assert_eq!(view["webSearch"]["requestCount"], 2);
    assert_eq!(
        view["webSearch"]["lastProvider"],
        format!("provider-{}", until - 1)
    );
    assert_timeline(&view);
    assert_eq!(view["model"]["requestCount"], 2);
    assert_eq!(view["previousPeriod"]["totalTokens"], 24.0);
    let global = monitor.read_at(
        &directory,
        None,
        None,
        Some(since as f64),
        until as f64,
        None,
    );
    let entries = global["topSessions"].as_array().unwrap();
    assert_eq!(entries.len(), 1, "raw and guided aliases must merge");
    assert_eq!(entries[0]["sessionId"], "s");
    assert_eq!(entries[0]["totalTokens"], 49.0);
    assert_eq!(entries[0]["requests"], 3);
    assert_eq!(entries[0]["kind"], "chat");
    let scoped = monitor.read_at(
        &directory,
        None,
        Some("s"),
        Some(since as f64),
        until as f64,
        None,
    );
    assert_eq!(
        scoped["model"]["requestCount"], 2,
        "guided scope takes precedence"
    );
    fs::write(
        &path,
        format!(
            "{}\n",
            json!({"ts":since,"scope":"btcc-guided:s","model":"m",
        "promptTokens":20,"cachedTokens":4,"totalTokens":30})
        ),
    )
    .unwrap();
    let view = monitor.read_at(
        &directory,
        Some("s"),
        None,
        Some(since as f64),
        until as f64,
        None,
    );
    assert_timeline(&view);
    assert_eq!(view["model"]["requestCount"], 1);
    assert_eq!(view["model"]["totalTokens"], 30.0);
    assert_eq!(view["previousPeriod"]["totalTokens"], 0.0);
    fs::remove_dir_all(directory).unwrap();
    Ok(())
}

#[tokio::test]
async fn usage_schedule_kind_uses_recorded_runs() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("usage-schedule-kind")?;
    fs::create_dir_all(setup.sandbox.data.join("metrics"))?;
    let now = chrono::Utc::now();
    fs::write(
        setup.sandbox.data.join("metrics/prompt-cache-usage.jsonl"),
        format!(
            "{}\n",
            json!({"ts":now.timestamp_millis()-1000,"scope":"btcc-guided:opaque-runtime-id","model":"m",
            "promptTokens":10,"cachedTokens":3,"totalTokens":12,"turnId":"scheduled-turn"})
        ),
    )?;
    let s = setup.start().await?;
    let db = butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))
        .unwrap();
    db.execute_batch("INSERT INTO chats(id,title,kind,runtime_session_hint,created_at,updated_at)
        VALUES('opaque-chat-id','Daily report','chat','opaque-runtime-id','2026-01-01','2026-01-01');
        INSERT INTO app_automations(id,title,prompt_body,target_kind,target_session_id,interval_seconds,state,last_run_state,created_at,updated_at)
        VALUES('a','Daily report','Report','chat','opaque-chat-id',3600,'paused','delivered','2026-01-01','2026-01-01');").unwrap();
    db.execute("INSERT INTO app_automation_runs(id,automation_id,target_session_id,state,trigger,started_at,turn_id)
        VALUES('r','a','opaque-chat-id','delivered','scheduled',?1,'unrelated-turn')",[(now - chrono::Duration::hours(25)).to_rfc3339()]).unwrap();
    // A schedule targeting this chat is insufficient: the actual usage turn must match.
    let reply = s.gw.get("/usage-monitor?since_hours=24").await?;
    assert_eq!(reply.data()["topSessions"][0]["kind"], "chat");
    db.execute(
        "UPDATE app_automation_runs SET turn_id='scheduled-turn'",
        [],
    )
    .unwrap();
    let reply = s.gw.get("/usage-monitor?since_hours=24").await?;
    let entry = &reply.data()["topSessions"][0];
    assert_eq!(entry["sessionId"], "opaque-chat-id");
    assert_eq!(entry["title"], "Daily report");
    assert_eq!(entry["kind"], "schedule");
    // The same chat can contain interactive and schedule turns. Any interactive
    // usage in the requested window keeps the combined entry classified as chat.
    let path = s.sandbox.data.join("metrics/prompt-cache-usage.jsonl");
    let mut log = fs::OpenOptions::new().append(true).open(&path)?;
    writeln!(
        log,
        "{}",
        json!({"ts":now.timestamp_millis()-25*3_600_000,
        "scope":"btcc-guided:opaque-runtime-id","model":"m","promptTokens":10,
        "cachedTokens":3,"totalTokens":12,"turnId":"interactive-turn"})
    )?;
    drop(log);
    let reply = s.gw.get("/usage-monitor?since_hours=30").await?;
    assert_eq!(reply.data()["topSessions"][0]["kind"], "chat");
    assert_eq!(reply.data()["topSessions"][0]["requests"], 2);
    let reply = s.gw.get("/usage-monitor?since_hours=24").await?;
    assert_eq!(reply.data()["topSessions"][0]["kind"], "schedule");
    // Deleted chats retain conversation provenance without inventing Butler work.
    db.execute("DELETE FROM app_automation_runs", []).unwrap();
    db.execute("DELETE FROM app_automations", []).unwrap();
    db.execute("DELETE FROM chats WHERE id='opaque-chat-id'", [])
        .unwrap();
    let reply = s.gw.get("/usage-monitor?since_hours=24").await?;
    let entry = &reply.data()["topSessions"][0];
    assert_eq!(entry["sessionId"], "opaque-runtime-id");
    assert_eq!(entry["kind"], "chat");
    assert!(entry["title"].is_null());
    drop(db);
    s.finish().await
}
