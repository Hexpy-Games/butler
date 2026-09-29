//! USE-06 — the usage monitor at owner scale: tens of thousands of usage rows
//! and hundreds of megabytes of transcripts answer in milliseconds once warm,
//! the session view counts only its own session, and a window or session
//! query never reads the transcripts.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::fmt::Write as _;
use std::fs;
use std::io::Write as _;
use std::path::Path;
use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::gateway::Gateway;
use butler_e2e::e2e::scenario::Setup;
use serde_json::Value;

/// Transcript files, and the size of each (about 320 MB in all).
const TRANSCRIPTS: usize = 640;
const TRANSCRIPT_BYTES: usize = 512 * 1024;
/// Usage rows in all, and how many of them belong to the two sessions.
const ROWS: u64 = 44_000;
const SESSION_ROWS: u64 = 1_500;
const OTHER_SESSION_ROWS: u64 = 400;
/// Rows written in the last 24 hours (every 20th row).
const RECENT_EVERY: u64 = 20;
/// A warm answer, in a debug build.
const WARM: Duration = Duration::from_millis(300);
/// The first read parses the log and, for the all-time view, every transcript.
const COLD: Duration = Duration::from_secs(90);

/// The tool events of one transcript: `calls` calls, all of `read_file`,
/// `failed` of the results failing, plus a failed delivery.
struct Tools {
    calls: u64,
    failed: u64,
}

fn tool_lines(out: &mut String, tools: &Tools) {
    for index in 0..tools.calls {
        let ok = index >= tools.failed;
        let _ = writeln!(
            out,
            r#"{{"eventId":"c{index}","sessionId":"s","kind":"tool_call","timestamp":"2026-09-22T12:00:00.000Z","payload":{{"name":"read_file","arguments":{{"path":"a.txt"}}}}}}"#
        );
        let _ = writeln!(
            out,
            r#"{{"eventId":"r{index}","sessionId":"s","kind":"tool_result","timestamp":"2026-09-22T12:00:01.000Z","payload":{{"name":"read_file","ok":{ok}}}}}"#
        );
    }
}

/// A transcript of `bytes` of chat filler around `tools`.
fn transcript(bytes: usize, tools: &Tools, failed_delivery: bool) -> String {
    let filler = format!(
        r#"{{"eventId":"e","sessionId":"s","kind":"turn_event","timestamp":"2026-09-22T12:00:02.000Z","payload":{{"text":"{}"}}}}"#,
        "lorem ipsum dolor sit amet ".repeat(30)
    );
    let mut out = String::with_capacity(bytes + 4096);
    tool_lines(&mut out, tools);
    if failed_delivery {
        out.push_str(
            r#"{"eventId":"d","sessionId":"s","kind":"delivery","timestamp":"2026-09-22T12:00:03.000Z","payload":{"ok":false,"error":"unreachable"}}"#,
        );
        out.push('\n');
    }
    while out.len() < bytes {
        out.push_str(&filler);
        out.push('\n');
    }
    out
}

fn usage_row(index: u64, scope: &str, ts: i64) -> String {
    format!(
        r#"{{"ts":{ts},"model":"openai/gpt-6-luna","scope":"{scope}","turnId":"turn-{index}","phase":"guided","promptTokens":1000,"cachedTokens":400,"cacheWriteTokens":0,"totalTokens":1200,"authMode":"subscription"}}"#
    )
}

/// What the generated data adds up to.
struct Expected {
    recent_rows: u64,
    tool_calls: u64,
    tool_failures: u64,
}

fn write_usage_log(data: &Path, now_ms: i64) -> Result<Expected, HarnessError> {
    fs::create_dir_all(data.join("metrics"))?;
    let mut log = std::io::BufWriter::new(fs::File::create(
        data.join("metrics/prompt-cache-usage.jsonl"),
    )?);
    let mut recent_rows = 0;
    for index in 0..ROWS {
        let scope = match index {
            i if i < SESSION_ROWS => "btcc-guided:butler/app-general",
            i if i < SESSION_ROWS + OTHER_SESSION_ROWS => "btcc-guided:butler/app-other",
            i if i % 3 == 0 => "worker",
            _ => "session-turn",
        };
        // Old rows are 40 to 60 days old; every 20th row is under a day old.
        let recent = index % RECENT_EVERY == 0;
        let age_ms = if recent {
            60_000 * (index as i64 % 1_000)
        } else {
            40 * 86_400_000 + 1_000 * index as i64
        };
        recent_rows += u64::from(recent);
        writeln!(log, "{}", usage_row(index, scope, now_ms - age_ms))?;
    }
    log.flush()?;
    Ok(Expected {
        recent_rows,
        tool_calls: 0,
        tool_failures: 0,
    })
}

fn write_transcripts(data: &Path, expected: &mut Expected) -> Result<(), HarnessError> {
    let directory = data.join("transcripts");
    fs::create_dir_all(&directory)?;
    for index in 0..TRANSCRIPTS {
        let tools = Tools {
            calls: 2 + (index % 5) as u64,
            failed: (index % 2) as u64,
        };
        expected.tool_calls += tools.calls;
        expected.tool_failures += tools.failed;
        let name = format!("worker_{index:04}.jsonl");
        fs::write(
            directory.join(name),
            transcript(TRANSCRIPT_BYTES, &tools, index % 7 == 0),
        )?;
    }
    // The session's own transcript: 7 calls, 3 of them failing.
    let session = Tools {
        calls: 7,
        failed: 3,
    };
    expected.tool_calls += session.calls;
    expected.tool_failures += session.failed;
    fs::write(
        directory.join("butler_app-general.jsonl"),
        transcript(TRANSCRIPT_BYTES, &session, false),
    )?;
    Ok(())
}

async fn timed(gw: &Gateway, path: &str) -> Result<(Duration, Value), HarnessError> {
    let started = Instant::now();
    let reply = gw.get(path).await?;
    let took = started.elapsed();
    assert_eq!(reply.status, 200, "{path}: {}", reply.text);
    Ok((took, reply.data().clone()))
}

#[tokio::test]
async fn use_06_usage_monitor_is_fast_at_owner_scale() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("USE-06")?;
    let mut expected = write_usage_log(&setup.sandbox.data, chrono_now())?;
    write_transcripts(&setup.sandbox.data, &mut expected)?;
    let s = setup.start().await?;

    // A window and a session answer without reading the transcripts: the
    // first read parses the log once, every later one is warm.
    let (cold, day) = timed(&s.gw, "/usage-monitor?since_hours=24").await?;
    assert!(cold < COLD, "24h cold {cold:?}");
    assert_eq!(day["model"]["requestCount"], expected.recent_rows, "{day}");
    assert_eq!(day["tools"]["calls"], 0, "no transcript scan for a window");
    assert!(
        day["availability"]["tools"]["reason"] == "unscoped_since_filter_requires_session",
        "{day}"
    );
    let mut worst = Duration::ZERO;
    for _ in 0..5 {
        let (took, again) = timed(&s.gw, "/usage-monitor?since_hours=24").await?;
        assert_eq!(again["model"], day["model"]);
        worst = worst.max(took);
    }
    eprintln!("USE-06 24h: cold {cold:?}, warm worst {worst:?}");
    assert!(worst < WARM, "24h warm {worst:?}");

    let (first, session) = timed(&s.gw, "/usage-monitor?session_id=general").await?;
    assert!(first < COLD, "session cold {first:?}");
    assert_eq!(session["filters"]["sessionId"], "general");
    assert_eq!(session["model"]["requestCount"], SESSION_ROWS, "{session}");
    assert_eq!(
        session["model"]["promptTokens"].as_f64(),
        Some((SESSION_ROWS * 1_000) as f64)
    );
    assert_eq!(session["tools"]["calls"], 7, "{}", session["tools"]);
    assert_eq!(session["tools"]["failures"], 3, "{}", session["tools"]);
    assert_eq!(session["model"]["byScope"].as_object().unwrap().len(), 1);
    let (_, other) = timed(&s.gw, "/usage-monitor?session_id=other").await?;
    assert_eq!(
        other["model"]["requestCount"], OTHER_SESSION_ROWS,
        "{other}"
    );
    assert_eq!(other["tools"]["calls"], 0);
    let (_, unknown) = timed(&s.gw, "/usage-monitor?session_id=nobody").await?;
    assert_eq!(unknown["model"]["requestCount"], 0);
    // The session view is small next to the all-time one.
    assert!(
        session.to_string().len() < 100_000,
        "{}",
        session.to_string().len()
    );
    let mut worst = Duration::ZERO;
    for _ in 0..5 {
        worst = worst.max(timed(&s.gw, "/usage-monitor?session_id=general").await?.0);
    }
    eprintln!("USE-06 session: cold {first:?}, warm worst {worst:?}");
    assert!(worst < WARM, "session warm {worst:?}");

    // Adding transcripts changes neither answer's speed: they are not read.
    let transcripts = s.sandbox.data.join("transcripts");
    for index in 0..40 {
        let tools = Tools {
            calls: 3,
            failed: 0,
        };
        fs::write(
            transcripts.join(format!("extra_{index:03}.jsonl")),
            transcript(TRANSCRIPT_BYTES, &tools, false),
        )?;
    }
    let (took, _) = timed(&s.gw, "/usage-monitor?since_hours=24").await?;
    assert!(took < WARM, "24h after new transcripts {took:?}");
    let (took, _) = timed(&s.gw, "/usage-monitor?session_id=general").await?;
    assert!(took < WARM, "session after new transcripts {took:?}");

    // All-time: the first read scans every transcript; the second is a
    // cache hit, and a grown transcript costs only its new lines.
    let (cold, all) = timed(&s.gw, "/usage-monitor").await?;
    assert!(cold < COLD, "all-time cold {cold:?}");
    assert_eq!(all["model"]["requestCount"], ROWS, "{all}");
    assert_eq!(
        all["tools"]["calls"],
        expected.tool_calls + 40 * 3,
        "{}",
        all["tools"]
    );
    assert_eq!(all["tools"]["failures"], expected.tool_failures);
    assert_eq!(
        all["tools"]["byTool"]["read_file"]["calls"],
        all["tools"]["calls"]
    );
    let (warm, again) = timed(&s.gw, "/usage-monitor").await?;
    assert!(warm < WARM, "all-time second read {warm:?} (cold {cold:?})");
    assert_eq!(again["tools"], all["tools"]);
    assert_eq!(again["model"], all["model"]);

    let mut grown = fs::OpenOptions::new()
        .append(true)
        .open(transcripts.join("worker_0001.jsonl"))?;
    let mut lines = String::new();
    tool_lines(
        &mut lines,
        &Tools {
            calls: 2,
            failed: 1,
        },
    );
    grown.write_all(lines.as_bytes())?;
    drop(grown);
    let (took, grew) = timed(&s.gw, "/usage-monitor").await?;
    assert!(took < WARM, "all-time after an append {took:?}");
    assert_eq!(
        grew["tools"]["calls"],
        all["tools"]["calls"].as_u64().unwrap() + 2
    );
    assert_eq!(
        grew["tools"]["failures"],
        all["tools"]["failures"].as_u64().unwrap() + 1
    );

    // A row appended to the usage log shows in the next read, without a rescan.
    let mut log = fs::OpenOptions::new()
        .append(true)
        .open(s.sandbox.data.join("metrics/prompt-cache-usage.jsonl"))?;
    writeln!(
        log,
        "{}",
        usage_row(ROWS, "btcc-guided:butler/app-general", chrono_now())
    )?;
    drop(log);
    let (took, session) = timed(&s.gw, "/usage-monitor?session_id=general").await?;
    assert!(took < WARM, "session after an appended row {took:?}");
    assert_eq!(session["model"]["requestCount"], SESSION_ROWS + 1);
    eprintln!(
        "USE-06 timings: 24h warm and session warm under {WARM:?}; all-time cold {cold:?}, warm {warm:?}"
    );
    s.finish().await
}

fn chrono_now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
