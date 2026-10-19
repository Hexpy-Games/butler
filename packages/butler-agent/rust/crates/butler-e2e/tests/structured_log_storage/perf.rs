//! LOG-PERF-01 and TRACE-06 share one owner-scale seed.
use super::*;

#[test]
fn perf_logs_owner_scale_query() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let root = root();
    let log = Logger::open(&root, Config::full()).unwrap();
    let padding = "x".repeat(54);
    let mut errors = Vec::new();
    let mut oldest_turn = Vec::new();
    let mut ground = Vec::new();
    let mut newest_ground = Vec::new();
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
        if matches!(n, 17 | 18) {
            r.trace_id = Some("0123456789abcdef0123456789abcdef".into());
            r.span_id = Some("0123456789abcdef".into());
            r.event = if n == 17 { "span.start" } else { "span.end" }.into();
            r.msg = "turn.run".into();
            r.duration_ms = (n == 18).then_some(1.0);
            r.attrs["message_id"] = "trace-message".into();
        }
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
        if n >= 1_249_800 {
            newest_ground.push(r.clone());
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
    let trace_start = Instant::now();
    let trace = log.trace("0123456789abcdef0123456789abcdef")?;
    assert_eq!(trace.spans.len(), 1);
    assert_eq!(trace.spans[0].name, "turn.run");
    assert_eq!(trace.spans[0].span_id, "0123456789abcdef");
    assert_eq!(trace.spans[0].duration_ms, Some(1.0));
    assert!(!trace.truncated);
    assert!(trace.scanned_bytes <= 32 * 1024 * 1024);
    eprintln!(
        "TRACE-06 spans=1 scanned_bytes={} query_ms={:.3}",
        trace.scanned_bytes,
        trace_start.elapsed().as_secs_f64() * 1000.0
    );
    let resolve_start = Instant::now();
    let resolved = log.resolve_trace(None, Some("chat-18".into()), Some("trace-message"))?;
    assert_eq!(resolved.trace_id, trace.trace_id);
    assert_eq!(resolved.spans.len(), 1);
    assert_eq!(resolved.spans[0].span_id, trace.spans[0].span_id);
    assert_eq!(resolved.spans[0].duration_ms, Some(1.0));
    assert!(!resolved.truncated);
    assert!(resolved.scanned_bytes <= 64 * 1024 * 1024);
    eprintln!(
        "TRACE-06 resolve_scanned_bytes={} resolve_ms={:.3}",
        resolved.scanned_bytes,
        resolve_start.elapsed().as_secs_f64() * 1000.0
    );
    let start = Instant::now();
    let page = log.query(&Query::default()).unwrap();
    assert_eq!(
        page.rows.iter().map(|r| r.msg.clone()).collect::<Vec<_>>(),
        ground.iter().rev().take(200).cloned().collect::<Vec<_>>()
    );
    assert!(page.scanned_bytes <= 32 * 1024 * 1024);
    for (row, expected) in page.rows.iter().zip(newest_ground.iter().rev()) {
        let mut actual = serde_json::to_value(row)?;
        let mut original = serde_json::to_value(expected)?;
        for key in ["content", "content_len", "content_hash", "body_ref"] {
            actual.as_object_mut().unwrap().remove(key);
            original.as_object_mut().unwrap().remove(key);
        }
        assert_eq!(actual, original, "complete metadata survives query");
        assert!(row.content.is_none());
        if let Some(content) = &expected.content {
            use sha2::{Digest, Sha256};
            let bytes = serde_json::to_vec(content)?;
            assert_eq!(row.content_len, Some(bytes.len()));
            assert_eq!(
                row.content_hash.as_deref(),
                Some(&format!("{:x}", Sha256::digest(&bytes))[..8])
            );
            let body = log.body(row.body_ref.as_deref().unwrap())?;
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&body)?,
                *content
            );
        } else {
            assert!(
                row.body_ref.is_none() && row.content_len.is_none() && row.content_hash.is_none()
            );
        }
    }

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
