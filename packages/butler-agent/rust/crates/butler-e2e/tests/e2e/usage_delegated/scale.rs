//! DELEG-USE-09 — per-type subtask totals at owner scale: 600 chats with two
//! subtasks each and 300k usage rows answer from the incremental index.
use super::Setup;
use butler_e2e::e2e::{HarnessError, gateway::Gateway};
use serde_json::Value;
use std::{
    fs,
    io::Write as _,
    path::Path,
    time::{Duration, Instant},
};

const CHATS: u64 = 600;
const ROWS: u64 = 300_000;
/// Each chat's rows cycle through 3 own calls, then one call of each subtask.
const CYCLE: u64 = 5;
const OWN_ROWS: u64 = 3;
const SPAN_MS: i64 = 28 * 24 * 3_600_000;
/// Rows are spread evenly over the span, oldest first.
const ROW_SPACING_MS: i64 = SPAN_MS / 300_000;
const SELECTED: u64 = 123;
/// A warm answer in a debug build; the cold read indexes the whole log once.
const WARM: Duration = Duration::from_millis(300);
const COLD: Duration = Duration::from_secs(90);

/// `[requests, prompt, cached, uncached, output, reasoning, total]`.
type Bucket = [u64; 7];

struct Row {
    chat: u64,
    /// `None` for the chat's own calls, else the subtask index.
    subtask: Option<u64>,
    ts: i64,
    prompt: u64,
    cached: u64,
    output: u64,
    reasoning: u64,
}

fn row(index: u64, start: i64) -> Row {
    let step = (index / CHATS) % CYCLE;
    let offset = i64::try_from(index).expect("row index fits i64") * ROW_SPACING_MS;
    Row {
        chat: index % CHATS,
        subtask: (step >= OWN_ROWS).then(|| step - OWN_ROWS),
        ts: start + offset,
        prompt: 1000 + index % 7,
        cached: 400 + index % 5,
        output: 200 + index % 3,
        reasoning: index % 11,
    }
}

fn line(row: &Row) -> String {
    let root = format!("butler/app-chat-{:03}", row.chat);
    let (scope, role) = match row.subtask {
        None => (root.clone(), "main"),
        Some(k) => (
            format!("chat-{:03}-sub-{k}", row.chat),
            if k == 0 { "worker" } else { "steward" },
        ),
    };
    format!(
        r#"{{"ts":{},"model":"openai/gpt-6-luna","scope":"btcc-guided:{scope}","rootSessionId":"{root}","role":"{role}","promptTokens":{},"cachedTokens":{},"reasoningTokens":{},"totalTokens":{}}}"#,
        row.ts,
        row.prompt,
        row.cached,
        row.reasoning,
        row.prompt + row.output
    )
}

fn seed(data: &Path, start: i64) -> Result<(), HarnessError> {
    fs::create_dir_all(data.join("metrics"))?;
    let mut log = std::io::BufWriter::new(fs::File::create(
        data.join("metrics/prompt-cache-usage.jsonl"),
    )?);
    for index in 0..ROWS {
        writeln!(log, "{}", line(&row(index, start)))?;
    }
    log.flush()?;
    Ok(())
}

/// The selected chat's own and subtask buckets for rows in `[since, until)`.
fn expected(start: i64, since: f64, until: f64) -> (Bucket, Bucket) {
    let (mut own, mut subtasks) = ([0; 7], [0; 7]);
    for index in (SELECTED..ROWS).step_by(usize::try_from(CHATS).expect("chat count fits usize")) {
        let row = row(index, start);
        if (row.ts as f64) < since || (row.ts as f64) >= until {
            continue;
        }
        let bucket = if row.subtask.is_some() {
            &mut subtasks
        } else {
            &mut own
        };
        let values = [
            1,
            row.prompt,
            row.cached,
            row.prompt - row.cached,
            row.output,
            row.reasoning,
            row.prompt + row.output,
        ];
        for (total, value) in bucket.iter_mut().zip(values) {
            *total += value;
        }
    }
    (own, subtasks)
}

fn assert_bucket(bucket: &Value, expected: Bucket, label: &str) {
    let keys = [
        "requestCount",
        "promptTokens",
        "cachedTokens",
        "uncachedTokens",
        "outputTokens",
        "reasoningTokens",
        "totalTokens",
    ];
    for (key, n) in keys.into_iter().zip(expected) {
        assert_eq!(
            bucket[key].as_f64(),
            Some(n as f64),
            "{label} {key}: {bucket}"
        );
    }
}

/// Exact own, subtask and total buckets for the window the view reports.
fn assert_split(view: &Value, start: i64, label: &str) {
    let since = view["filters"]["sinceTs"].as_f64().unwrap_or(f64::MIN);
    let until = view["filters"]["untilTs"].as_f64().unwrap_or(f64::MAX);
    let (own, subtasks) = expected(start, since, until);
    assert!(subtasks[0] > 0 && own[0] > 0, "{label}: empty window");
    let model = &view["model"];
    assert_bucket(&model["subtasks"], subtasks, label);
    assert_bucket(&model["byRole"]["main"], own, label);
    assert_bucket(model, std::array::from_fn(|i| own[i] + subtasks[i]), label);
}

async fn timed(gw: &Gateway, path: &str) -> Result<(Duration, Value), HarnessError> {
    let started = Instant::now();
    let reply = gw.get(path).await?;
    let took = started.elapsed();
    assert_eq!(reply.status, 200, "{path}: {}", reply.text);
    Ok((took, reply.data().clone()))
}

#[tokio::test]
async fn perf_usage_subtask_split_owner_scale() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("DELEG-USE-09")?;
    let start = chrono::Utc::now().timestamp_millis() - SPAN_MS - 60_000;
    seed(&setup.sandbox.data, start)?;
    let s = setup.start().await?;

    let (cold, all) = timed(&s.gw, "/usage-monitor?since_hours=720").await?;
    assert_eq!(all["model"]["requestCount"], ROWS);
    assert!(all["model"]["subtasks"].is_null(), "all chats stay unsplit");
    let top = all["topSessions"].as_array().unwrap();
    assert_eq!(top.len(), 200);
    assert!(
        top.iter().all(|item| item["requests"] == ROWS / CHATS),
        "{top:?}"
    );
    eprintln!("DELEG-USE-09 cold 30-day read (indexes {ROWS} rows): {cold:?}");
    butler_e2e::assert_wall_clock_budget!(cold, COLD, "cold 30-day read");

    let session = format!("chat-{SELECTED:03}");
    for (label, query) in [
        ("30-day", "&since_hours=720"),
        ("24-hour", "&since_hours=24"),
        ("all-time", ""),
    ] {
        let path = format!("/usage-monitor?session_id={session}{query}");
        let mut worst = Duration::ZERO;
        for _ in 0..5 {
            let (took, view) = timed(&s.gw, &path).await?;
            assert_split(&view, start, label);
            worst = worst.max(took);
        }
        eprintln!("DELEG-USE-09 session {label} warm worst of 5: {worst:?}");
        butler_e2e::assert_wall_clock_budget!(worst, WARM, label);
    }
    s.finish().await
}
