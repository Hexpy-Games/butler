//! Storage E2Es use the same writer API that agent producers use.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_log::{Config, Logger, Query, Record};
use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};

fn root() -> PathBuf {
    let root = std::env::temp_dir().join(format!("butler-logs-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    root
}
fn record(n: usize, level: &str) -> Record {
    let mut r = Record::new(level, "turn", "turn.finished", &format!("row {n}"));
    static START: std::sync::OnceLock<chrono::DateTime<chrono::Utc>> = std::sync::OnceLock::new();
    let start = START.get_or_init(|| chrono::Utc::now() - chrono::Duration::hours(1));
    r.ts = (*start + chrono::Duration::microseconds(i64::try_from(n).unwrap()))
        .to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
    r.turn_id = Some(format!("turn-{}", n % 5000));
    r.chat_id = Some(format!("chat-{}", n % 600));
    r
}
fn walk(log: &Logger, mut q: Query) -> Vec<Record> {
    let mut rows = Vec::new();
    let mut total_scanned = 0;
    let mut max_scanned = 0;
    let mut pages = 0;
    loop {
        let page = log.query(&q).unwrap();
        assert!(page.scanned_bytes <= 32 * 1024 * 1024);
        total_scanned += page.scanned_bytes;
        max_scanned = max_scanned.max(page.scanned_bytes);
        pages += 1;
        rows.extend(page.rows);
        q.cursor = page.cursor;
        if q.cursor.is_none() {
            assert!(page.exhausted);
            break;
        }
    }
    eprintln!(
        "LOG-WALK rows={} pages={pages} scanned_bytes={total_scanned} max_scanned_bytes={max_scanned}",
        rows.len()
    );
    rows
}

#[test]
fn logs_cursor_walk_complete() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let root = root();
    let log = Logger::open(&root, Config::detailed()).unwrap();
    let app_root = root.join("app-writer");
    let app = Logger::open(&app_root, Config::detailed()).unwrap();
    for n in 0..650 {
        log.record(record(n * 2, "INFO")).unwrap();
        let mut row = record(n * 2 + 1, "INFO");
        row.process = "app.main".into();
        app.record(row).unwrap();
    }
    app.shutdown().unwrap();
    fs::rename(app_root.join("logs/agent"), root.join("logs/app")).unwrap();
    log.flush().unwrap();
    let mut data_bytes = 0;
    for source in ["agent", "app"] {
        for entry in fs::read_dir(root.join("logs").join(source).join("main"))? {
            let entry = entry?;
            if entry.path().extension().is_some_and(|ext| ext == "jsonl") {
                data_bytes += entry.metadata()?.len();
            }
        }
    }
    let newest = log.query(&Query {
        q: Some("row 1299".into()),
        limit: 1,
        ..Query::default()
    })?;
    assert_eq!(newest.rows.len(), 1);
    assert_eq!(newest.rows[0].msg, "row 1299");
    assert!(
        newest.scanned_bytes < data_bytes,
        "older segments must not delay the newest result"
    );
    let rows = walk(
        &log,
        Query {
            limit: 37,
            ..Query::default()
        },
    );
    assert_eq!(rows.len(), 1300);
    for (n, row) in rows.iter().enumerate() {
        assert_eq!(row.msg, format!("row {}", 1299 - n));
    }
    for source in ["agent", "app"] {
        assert_eq!(
            walk(
                &log,
                Query {
                    source: source.into(),
                    ..Query::default()
                }
            )
            .len(),
            650
        );
    }
    log.shutdown().unwrap();
    fs::remove_dir_all(root).unwrap();
    Ok(())
}

#[test]
fn logs_rotation_index_retention() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let root = root();
    let main = root.join("logs/agent/main");
    fs::create_dir_all(&main).unwrap();
    for n in 0..6 {
        let path = main.join(format!(
            "{}-{n:04}.jsonl",
            chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
        ));
        let file = fs::File::create(path).unwrap();
        file.set_len(16 * 1024 * 1024).unwrap();
    }
    let old = main.join(format!(
        "{}-0000.jsonl",
        (chrono::Utc::now() - chrono::Duration::days(20)).format("%Y%m%dT%H%M%SZ")
    ));
    fs::write(&old, b"{}\n").unwrap();
    fs::OpenOptions::new().write(true).open(&old)?.set_times(
        fs::FileTimes::new().set_modified(std::time::SystemTime::now() - Duration::from_hours(480)),
    )?;
    let log = Logger::open(&root, Config::default()).unwrap();
    assert!(!old.exists());
    let storage = log.storage().unwrap();
    assert!(
        storage
            .stores
            .iter()
            .find(|s| s.id == "agent/main")
            .unwrap()
            .bytes
            <= 64 * 1024 * 1024
    );
    for item in fs::read_dir(&main).unwrap() {
        let path = item.unwrap().path();
        if path.extension().is_some_and(|x| x == "jsonl") {
            assert!(path.with_extension("idx").exists());
        }
    }
    log.shutdown().unwrap();
    fs::remove_dir_all(root).unwrap();
    Ok(())
}

#[test]
fn logs_never_contain_secrets() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let root = root();
    let log = Logger::open(&root, Config::full()).unwrap();
    let secrets = [
        "gateway-literal-credential",
        "10293847",
        "fake-provider-credential",
    ];
    for secret in secrets {
        butler_log::register_secret(secret);
    }
    let mut r = record(1, "INFO");
    r.msg = secrets.join(" ");
    r.attrs = json!({"url":"https://example.org/?key=sensitive&code=1234&safe=yes", "headers":butler_log::redact_headers([("authorization","Bearer unknown"),("x-extra","secret header"),("content-type","text/plain")])});
    r.content = Some(json!({"payload":secrets.join(" ").repeat(2000)}));
    log.record(r).unwrap();
    log.flush().unwrap();
    let page = log.query(&Query::default()).unwrap();
    let body = log.body(page.rows[0].body_ref.as_ref().unwrap()).unwrap();
    let export = log.export(None, None, true).unwrap();
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(export)).unwrap();
    for n in 0..archive.len() {
        use std::io::Read;
        let mut item = archive.by_index(n).unwrap();
        let mut bytes = Vec::new();
        item.read_to_end(&mut bytes).unwrap();
        let decoded = if item.name().ends_with(".zst") {
            zstd::decode_all(bytes.as_slice()).unwrap()
        } else {
            bytes
        };
        for secret in secrets {
            assert!(!String::from_utf8_lossy(&decoded).contains(secret));
        }
    }
    for secret in secrets {
        assert!(!String::from_utf8_lossy(&body).contains(secret));
    }
    let text = serde_json::to_string(&page).unwrap();
    for forbidden in ["sensitive", "secret header", "Bearer unknown"] {
        assert!(!text.contains(forbidden));
    }
    assert!(root.join("logs/agent/bodies").exists());
    let changed = log.configure(Config::default()).unwrap();
    assert!(changed.freed_bytes > 0);
    assert!(!root.join("logs/agent/debug").exists());
    assert!(!root.join("logs/agent/bodies").exists());
    log.shutdown().unwrap();
    fs::remove_dir_all(root).unwrap();
    Ok(())
}

#[test]
fn logs_tracing_updates_filters_and_inherits_span_ids() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    struct Probe(Arc<AtomicBool>);
    impl std::fmt::Debug for Probe {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            self.0.store(true, Ordering::Relaxed);
            f.write_str("probe")
        }
    }
    fn probe(value: &Probe) {
        tracing::info!(target:"butler.provider",category="provider",event="provider.probe",?value);
    }
    fn dependency_enabled() -> bool {
        tracing::enabled!(target: "dependency_probe", tracing::Level::TRACE)
    }
    fn marker(content: &str) {
        tracing::trace!(target:"butler.provider",category="provider",event="provider.marker",content);
    }
    let root = root();
    let log = Logger::open(&root, Config::default()).unwrap();
    butler_log::install(log.clone()).unwrap();
    assert_eq!(
        tracing::level_filters::LevelFilter::current(),
        tracing::level_filters::LevelFilter::INFO
    );
    marker("disabled");
    assert!(!dependency_enabled());
    let mut config = Config::default();
    config
        .category_levels
        .insert("provider".into(), "warn".into());
    log.configure(config).unwrap();
    let formatted = Arc::new(AtomicBool::new(false));
    probe(&Probe(formatted.clone()));
    assert!(!formatted.load(Ordering::Relaxed));
    log.configure(Config::full()).unwrap();
    assert!(dependency_enabled());
    assert_eq!(
        tracing::level_filters::LevelFilter::current(),
        tracing::level_filters::LevelFilter::TRACE
    );
    let span = tracing::info_span!(target:"butler.turn","turn",trace_id="trace-context",span_id="span-context",parent_span_id="parent-context",chat_id="chat-context",turn_id="turn-context");
    {
        let _entered = span.enter();
        marker(&"payload ".repeat(2000));
        probe(&Probe(formatted.clone()));
    }
    assert!(formatted.load(Ordering::Relaxed));
    let rows = log
        .query(&Query {
            trace_id: Some("trace-context".into()),
            ..Query::default()
        })
        .unwrap()
        .rows;
    assert_eq!(rows.len(), 3);
    assert!(
        rows.iter()
            .any(|row| row.event == "span.start" && row.msg == "turn")
    );
    for row in &rows {
        assert_eq!(row.span_id.as_deref(), Some("span-context"));
        assert_eq!(row.parent_span_id.as_deref(), Some("parent-context"));
        assert_eq!(row.chat_id.as_deref(), Some("chat-context"));
        assert_eq!(row.turn_id.as_deref(), Some("turn-context"));
    }
    let marker = rows.iter().find(|r| r.event == "provider.marker").unwrap();
    assert_eq!(marker.level, "TRACE");
    assert!(marker.content.is_none());
    assert!(log.body(marker.body_ref.as_ref().unwrap()).unwrap().len() > 8192);
    log.configure(Config::default())?;
    assert!(!dependency_enabled());
    assert_eq!(
        tracing::level_filters::LevelFilter::current(),
        tracing::level_filters::LevelFilter::INFO
    );
    let visited = Arc::new(AtomicBool::new(false));
    tracing::debug!(target:"butler.turn", category="turn", value=?Probe(visited.clone()));
    assert!(!visited.load(Ordering::Relaxed));
    let mut config = Config::default();
    config.category_levels.insert("turn".into(), "DEBUG".into());
    log.configure(config)?;
    assert_eq!(
        tracing::level_filters::LevelFilter::current(),
        tracing::level_filters::LevelFilter::DEBUG
    );
    tracing::debug!(target:"butler.turn", category="turn", value=?Probe(visited.clone()));
    assert!(visited.load(Ordering::Relaxed));
    log.configure(Config::default())?;
    {
        let span =
            tracing::info_span!(target:"butler.turn", "context", trace_id="low-level-context");
        let _entered = span.enter();
        tracing::info!(target:"butler.turn", category="turn", event="context.probe", "context");
    }
    let rows = log
        .query(&Query {
            trace_id: Some("low-level-context".into()),
            ..Query::default()
        })?
        .rows;
    assert_eq!(rows.len(), 3);
    for event in ["context.probe", "span.start", "span.end"] {
        assert_eq!(rows.iter().filter(|row| row.event == event).count(), 1);
    }
    let context = butler_log::TraceContext {
        trace_id: Some("abcdef0123456789abcdef0123456789".into()),
        ..Default::default()
    };
    drop(context.span("worker.claim"));
    drop(context.span("worker.finish"));
    let trace = log.trace(context.trace_id.as_deref().unwrap())?;
    assert_eq!(
        trace
            .spans
            .iter()
            .map(|s| s.name.as_str())
            .collect::<Vec<_>>(),
        vec!["worker.claim", "worker.finish"]
    );
    // Previously persisted access records used a child ID rather than the server ID.
    let mut server = Record::new("INFO", "http.server", "span.end", "http.server");
    server.trace_id = context.trace_id.clone();
    server.span_id = Some("1234567890abcdef".into());
    server.duration_ms = Some(3.0);
    let mut access = server.clone();
    access.event = "http.request".into();
    access.span_id = Some("fedcba0987654321".into());
    access.parent_span_id = server.span_id.clone();
    access.attrs = json!({"method":"POST", "route":"/messages", "status":202});
    log.record_reliable(server)?;
    log.record_reliable(access)?;
    let trace = log.trace(context.trace_id.as_deref().unwrap())?;
    let inbound: Vec<_> = trace
        .spans
        .iter()
        .filter(|s| s.category == "http.server")
        .collect();
    assert_eq!(inbound.len(), 1);
    assert_eq!(inbound[0].name, "http.server");
    assert_eq!(inbound[0].attrs["route"], "/messages");
    assert_eq!(inbound[0].attrs["status"], 202);
    assert!(inbound[0].has_details);
    log.shutdown().unwrap();
    fs::remove_dir_all(root).unwrap();
    Ok(())
}

#[test]
fn logs_registered_secrets_preserve_record_schema() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let root = root();
    let log = Logger::open(&root, Config::default())?;
    butler_log::register_secret("event");
    let mut row = record(1, "INFO");
    row.attrs = json!({"value":"event"});
    log.record(row)?;
    log.flush()?;
    let page = log.query(&Query::default())?;
    assert_eq!(page.rows.len(), 1);
    assert_eq!(page.rows[0].event, "turn.finished");
    assert_eq!(page.rows[0].attrs["value"], "[REDACTED]");
    log.shutdown()?;
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn logs_inline_strings_include_marker_within_limit() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let root = root();
    let log = Logger::open(&root, Config::default())?;
    let original = "가".repeat(4000);
    let mut row = record(1, "INFO");
    row.msg = original.clone();
    log.record(row)?;
    let page = log.query(&Query::default())?;
    let text = &page.rows[0].msg;
    assert!(text.len() <= 8192);
    let (prefix, marker) = text.rsplit_once("…truncated ").unwrap();
    let omitted = marker.strip_suffix(" B").unwrap().parse::<usize>()?;
    assert_eq!(prefix.len() + omitted, original.len());
    assert!(original.starts_with(prefix));
    log.shutdown()?;
    fs::remove_dir_all(root)?;
    Ok(())
}

#[path = "e2e/logs_storage.rs"]
mod regressions;

#[path = "e2e/logs_queue.rs"]
mod queue;

#[path = "structured_log_storage/perf.rs"]
mod perf;

#[test]
fn app_segments_index_live_tails_without_producer_indexes() -> Result<(), Box<dyn std::error::Error>>
{
    butler_e2e::gate!();
    use std::io::Write;
    let root = root();
    let log = Logger::open(&root, Config::default())?;
    let dir = root.join("logs/app/main");
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!(
        "{}-0001.jsonl",
        chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
    ));
    let mut file = fs::File::create(&path)?;
    let mut row = record(1, "INFO");
    row.process = "app.renderer".into();
    row.trace_id = Some("0123456789abcdef0123456789abcdef".into());
    let line = serde_json::to_vec(&row)?;
    file.write_all(&line)?;
    let query = Query {
        source: "app".into(),
        ..Query::default()
    };
    assert!(
        log.query(&query)?.rows.is_empty(),
        "partial line is not indexed"
    );
    file.write_all(b"\n")?;
    assert_eq!(log.query(&query)?.rows.len(), 1);
    file.write_all(&line)?;
    file.write_all(b"\n")?;
    assert_eq!(
        log.query(&query)?.rows.len(),
        2,
        "new tail is discovered once"
    );
    assert_eq!(log.query(&query)?.rows.len(), 2, "unchanged file is stable");
    log.shutdown()?;
    let reopened = Logger::open(&root, Config::default())?;
    assert_eq!(
        reopened.query(&query)?.rows.len(),
        2,
        "App index rebuilds on reopen"
    );
    reopened.shutdown()?;
    assert!(
        !path.with_extension("idx").exists(),
        "Agent never writes App indexes"
    );
    fs::remove_dir_all(root)?;
    Ok(())
}

#[path = "structured_log_storage/app.rs"]
mod app;
