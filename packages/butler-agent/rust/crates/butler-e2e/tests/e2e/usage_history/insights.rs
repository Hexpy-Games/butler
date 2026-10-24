//! Activity statistics from the real HTTP route, including a warm owner-scale read.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use chrono::{Datelike, Days, FixedOffset, NaiveDate, TimeZone, Utc};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufWriter, Write},
    path::Path,
    time::{Duration, Instant},
};

fn today() -> NaiveDate {
    Utc::now()
        .with_timezone(&FixedOffset::east_opt(9 * 3600).unwrap())
        .date_naive()
}
fn date(age: u64) -> NaiveDate {
    today().checked_sub_days(Days::new(age)).unwrap()
}
fn timestamp(age: u64) -> i64 {
    FixedOffset::east_opt(9 * 3600)
        .unwrap()
        .from_local_datetime(&date(age).and_hms_opt(12, 0, 0).unwrap())
        .unwrap()
        .timestamp_millis()
}
fn row(ts: i64, tokens: u64, turn: &str, chat: bool) -> Value {
    json!({"ts":ts,"model":"openai/gpt-6-luna","scope":if chat {"btcc-guided:butler/app-general"} else {"internal"},
        "rootSessionId":if chat {Some("butler/app-general")} else {None},"turnId":turn,
        "promptTokens":tokens,"cachedTokens":0,"totalTokens":tokens})
}
fn seed(path: &Path, rows: &[Value]) -> Result<(), HarnessError> {
    fs::create_dir_all(path.parent().unwrap())?;
    let mut out = BufWriter::new(fs::File::create(path)?);
    for row in rows {
        writeln!(out, "{row}")?;
    }
    Ok(())
}
fn assert_window(view: &Value) {
    let days = view["days"].as_array().unwrap();
    assert_eq!(days.len(), 371);
    for (index, day) in days.iter().enumerate() {
        assert_eq!(day[0], date(370 - index as u64).to_string());
        assert!(day[1].as_f64().unwrap() >= 0.0);
    }
    let sum: f64 = days.iter().map(|day| day[1].as_f64().unwrap()).sum();
    assert_eq!(
        sum + view["priorTotal"].as_f64().unwrap(),
        view["lifetimeTokens"].as_f64().unwrap()
    );
}
#[tokio::test]
async fn usage_history_insights_local_stats_and_append() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("usage-history-insights")?.env("TZ", "Asia/Seoul");
    let path = setup.sandbox.data.join("metrics/prompt-cache-usage.jsonl");
    let mut rows = vec![row(timestamp(400), 40, "old", false)];
    for (age, total, turn) in [
        (10, 100, "short"),
        (9, 100, "long"),
        (8, 100, "long"),
        (4, 200, "a"),
        (3, 200, "b"),
        (2, 20, "c"),
        (1, 20, "d"),
    ] {
        rows.push(row(timestamp(age), total, turn, true));
    }
    // 15:10 UTC is 00:10 on the following Seoul calendar date.
    let boundary = date(20)
        .and_hms_opt(15, 10, 0)
        .unwrap()
        .and_utc()
        .timestamp_millis();
    rows.push(row(boundary, 30, "boundary", false));
    seed(&path, &rows)?;
    let s = setup.start().await?;
    let db = butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    db.execute(
        "UPDATE chats SET title='Longest conversation' WHERE id='general'",
        [],
    )?;
    let reply = s.gw.get("/usage-history").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let view = reply.data();
    assert_window(view);
    assert_eq!(view["lifetimeTokens"], 810.0);
    assert_eq!(view["priorTotal"], 40.0);
    assert_eq!(
        view["busiestDay"],
        json!({"date":date(3).to_string(),"tokens":200.0})
    );
    assert_eq!(
        view["longestTask"],
        json!({"durationMs":86_400_000.0,"sessionId":"general","title":"Longest conversation"})
    );
    assert_eq!(
        view["longestStreak"],
        json!({"days":4,"start":date(4).to_string(),"end":date(1).to_string()})
    );
    assert_eq!(
        view["currentStreak"],
        json!({"days":4,"start":date(4).to_string()})
    );
    assert_eq!(view["firstActiveDate"], date(400).to_string());
    assert_eq!(view["timeZone"], "Asia/Seoul");
    let days = view["days"].as_array().unwrap();
    assert_eq!(days[350], json!([date(20).to_string(), 0.0]));
    assert_eq!(days[351], json!([date(19).to_string(), 30.0]));
    let mut log = fs::OpenOptions::new().append(true).open(&path)?;
    writeln!(log, "{}", row(timestamp(0), 50, "today", true))?;
    let updated = s.gw.get("/usage-history").await?;
    assert_window(updated.data());
    assert_eq!(updated.data()["lifetimeTokens"], 860.0);
    assert_eq!(updated.data()["currentStreak"]["days"], 5);
    let overview = s.gw.get("/usage-monitor").await?;
    assert_eq!(
        overview.data()["model"]["totalTokens"],
        updated.data()["lifetimeTokens"]
    );
    drop(db);
    s.finish().await
}
#[tokio::test]
async fn usage_history_insights_empty_inactive_and_rotation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("usage-history-empty")?.env("TZ", "Asia/Seoul");
    let path = setup.sandbox.data.join("metrics/prompt-cache-usage.jsonl");
    let s = setup.start().await?;
    let reply = s.gw.get("/usage-history").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let view = reply.data();
    assert_window(view);
    assert_eq!(view["lifetimeTokens"], 0.0);
    for key in ["busiestDay", "longestTask", "firstActiveDate"] {
        assert!(view[key].is_null(), "{key}");
    }
    assert_eq!(
        view["longestStreak"],
        json!({"days":0,"start":null,"end":null})
    );
    assert_eq!(view["currentStreak"], json!({"days":0,"start":null}));
    seed(&path, &[row(timestamp(2), 10, "single", false)])?;
    let inactive = s.gw.get("/usage-history").await?;
    assert_window(inactive.data());
    assert_eq!(
        inactive.data()["currentStreak"],
        json!({"days":0,"start":null})
    );
    assert_eq!(
        inactive.data()["longestTask"],
        json!({"durationMs":0.0,"sessionId":"internal","title":null})
    );
    fs::rename(&path, path.with_extension("old"))?;
    seed(&path, &[])?;
    let reset = s.gw.get("/usage-history").await?;
    assert_window(reset.data());
    assert_eq!(reset.data()["lifetimeTokens"], 0.0);
    assert!(reset.data()["longestTask"].is_null());
    s.finish().await
}
#[tokio::test]
async fn usage_history_insights_owner_scale_warm_complete() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("usage-history-scale")?.env("TZ", "Asia/Seoul");
    let path = setup.sandbox.data.join("metrics/prompt-cache-usage.jsonl");
    fs::create_dir_all(path.parent().unwrap())?;
    let mut log = BufWriter::new(fs::File::create(&path)?);
    let line = row(timestamp(1), 1, "scale", false).to_string();
    for _ in 0..300_000 {
        writeln!(log, "{line}")?;
    }
    log.flush()?;
    drop(log);
    let s = setup.start().await?;
    let cold = s.gw.get("/usage-history").await?;
    assert_eq!(cold.status, 200, "{}", cold.text);
    let start = Instant::now();
    let warm = s.gw.get("/usage-history").await?;
    let elapsed = start.elapsed();
    assert_eq!(warm.status, 200, "{}", warm.text);
    assert_window(warm.data());
    assert_eq!(warm.data(), cold.data());
    assert_eq!(warm.data()["lifetimeTokens"], 300_000.0);
    assert_eq!(warm.data()["days"][369][1], 300_000.0);
    assert_eq!(warm.data()["currentStreak"]["days"], 1);
    eprintln!("usage-history 300000 rows warm: {elapsed:?}");
    butler_e2e::assert_wall_clock_budget!(
        elapsed,
        Duration::from_millis(300),
        "usage-history warm response"
    );
    s.finish().await
}

#[tokio::test]
async fn usage_history_provider_month_uses_local_calendar_and_appends() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let setup = Setup::new("usage-provider-month")?.env("TZ", "Asia/Seoul");
    let path = setup.sandbox.data.join("metrics/prompt-cache-usage.jsonl");
    let first = today().with_day(1).unwrap();
    let stamp = |date: NaiveDate| {
        FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .from_local_datetime(&date.and_hms_opt(0, 10, 0).unwrap())
            .unwrap()
            .timestamp_millis()
    };
    seed(
        &path,
        &[
            row(stamp(first.pred_opt().unwrap()), 900, "last-month", false),
            row(stamp(first), 100, "month-start", false),
            row(stamp(today()), 25, "month-today", false),
        ],
    )?;
    let s = setup.start().await?;
    let registered =
        s.gw.post(
            "/model-catalog/registered-models",
            json!({
                "provider_id":s.model.provider(), "model_id":s.model.model,
                "auth_type":"api_key", "api_key":"month-usage-stub-key"
            }),
        )
        .await?;
    assert!(registered.status < 300, "{}", registered.text);
    let read = s.gw.get("/usage-monitor?since_hours=1").await?;
    assert_eq!(read.status, 200, "{}", read.text);
    let provider = |view: &Value| {
        view["providerUsage"]["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["providerId"] == "openai")
            .unwrap()["monthTokens"]
            .as_f64()
            .unwrap()
    };
    assert_eq!(provider(read.data()), 125.0, "{}", read.text);
    let mut log = fs::OpenOptions::new().append(true).open(&path)?;
    writeln!(log, "{}", row(stamp(today()), 10, "appended", false))?;
    let updated = s.gw.get("/usage-monitor?since_hours=1").await?;
    assert_eq!(updated.status, 200, "{}", updated.text);
    assert_eq!(provider(updated.data()), 135.0, "{}", updated.text);
    s.finish().await
}
