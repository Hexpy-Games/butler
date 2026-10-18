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
    r.ts = format!(
        "2026-10-18T10:{:02}:{:02}.{:06}Z",
        n / 60_000_000,
        n / 1_000_000 % 60,
        n % 1_000_000
    );
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
    let old = main.join("20000101T000000Z-0000.jsonl");
    fs::write(&old, b"{}\n").unwrap();
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
fn perf_logs_owner_scale_query() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let root = root();
    let log = Logger::open(&root, Config::full()).unwrap();
    let padding = "x".repeat(54);
    let mut errors = Vec::new();
    let mut oldest_turn = Vec::new();
    let mut ground = Vec::new();
    for n in 0..1_250_000 {
        let level = if n % 100_003 == 0 {
            "ERROR"
        } else if n % 5 == 0 {
            "INFO"
        } else {
            "DEBUG"
        };
        let mut r = record(n, level);
        r.attrs = json!({"padding":padding});
        if n % 100 == 1 {
            use sha2::{Digest, Sha256};
            use std::fmt::Write;
            let mut content = String::with_capacity(44800);
            for i in 0..700 {
                write!(&mut content, "{:x}", Sha256::digest(format!("{n}:{i}"))).unwrap();
            }
            r.content = Some(json!(content));
        }
        if level == "ERROR" {
            errors.push(r.msg.clone());
        }
        if r.turn_id.as_deref() == Some("turn-1") {
            oldest_turn.push(r.msg.clone());
        }
        ground.push(r.msg.clone());
        log.record_reliable(r).unwrap();
    }
    log.shutdown().unwrap();
    let log = Logger::open(&root, Config::full()).unwrap();
    let stores = log.storage().unwrap();
    for (id, minimum) in [
        ("agent/main", 60 * 1024 * 1024),
        ("agent/debug", 240 * 1024 * 1024),
        ("agent/bodies", 240 * 1024 * 1024),
    ] {
        let store = stores.stores.iter().find(|s| s.id == id).unwrap();
        assert!(
            store.bytes >= minimum && store.bytes <= store.limit_bytes,
            "{id}: {}",
            store.bytes
        );
        eprintln!("LOG-PERF-01 store={id} bytes={}", store.bytes);
    }
    let start = Instant::now();
    let page = log.query(&Query::default()).unwrap();
    assert_eq!(
        page.rows.iter().map(|r| r.msg.clone()).collect::<Vec<_>>(),
        ground.iter().rev().take(200).cloned().collect::<Vec<_>>()
    );
    assert!(page.scanned_bytes <= 32 * 1024 * 1024);
    let turn = walk(
        &log,
        Query {
            turn_id: Some("turn-1".into()),
            ..Query::default()
        },
    );
    assert_eq!(
        turn.iter().map(|r| r.msg.clone()).collect::<Vec<_>>(),
        oldest_turn.into_iter().rev().collect::<Vec<_>>()
    );
    let rows = walk(
        &log,
        Query {
            level: Some("ERROR".into()),
            ..Query::default()
        },
    );
    assert_eq!(
        rows.iter().map(|r| r.msg.clone()).collect::<Vec<_>>(),
        errors.into_iter().rev().collect::<Vec<_>>()
    );
    butler_e2e::assert_wall_clock_budget!(start.elapsed(), Duration::from_secs(5), "LOG-PERF-01");
    eprintln!(
        "LOG-PERF-01 rows=1250000 latest_scanned_bytes={}",
        page.scanned_bytes
    );
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
    fn marker(content: &str) {
        tracing::trace!(target:"butler.provider",category="provider",event="provider.marker",content);
    }
    let root = root();
    let log = Logger::open(&root, Config::default()).unwrap();
    butler_log::install(log.clone()).unwrap();
    marker("disabled");
    let mut config = Config::default();
    config
        .category_levels
        .insert("provider".into(), "warn".into());
    log.configure(config).unwrap();
    let formatted = Arc::new(AtomicBool::new(false));
    probe(&Probe(formatted.clone()));
    assert!(!formatted.load(Ordering::Relaxed));
    log.configure(Config::full()).unwrap();
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
    assert_eq!(rows.len(), 2);
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
    log.shutdown().unwrap();
    fs::remove_dir_all(root).unwrap();
    Ok(())
}
