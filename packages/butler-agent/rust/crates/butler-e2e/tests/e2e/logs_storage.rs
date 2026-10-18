//! Regressions exercise the real logging writer and on-disk format.
use super::{record, root};
use butler_log::{Config, Logger, Query, Record};
use std::{
    fs,
    io::Read,
    time::{Duration, Instant, SystemTime},
};

#[test]
fn logs_old_name_recent_record_survives_restart() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let root = root();
    let log = Logger::open(&root, Config::default())?;
    let row = Record::new("INFO", "turn", "recent", "recent record");
    log.record(row.clone())?;
    log.shutdown()?;
    let main = root.join("logs/agent/main");
    let path = fs::read_dir(&main)?
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .unwrap();
    let old = main.join(format!(
        "{}-0001.jsonl",
        (chrono::Utc::now() - chrono::Duration::days(20)).format("%Y%m%dT%H%M%SZ")
    ));
    fs::rename(&path, &old)?;
    fs::rename(path.with_extension("idx"), old.with_extension("idx"))?;
    let log = Logger::open(&root, Config::default())?;
    let page = log.query(&Query::default())?;
    assert_eq!(page.rows.len(), 1);
    assert_eq!(page.rows[0].ts, row.ts);
    assert_eq!(page.rows[0].msg, row.msg);
    log.shutdown()?;
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn logs_active_lanes_survive_retention() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let root = root();
    let log = Logger::open(&root, Config::full())?;
    for level in ["INFO", "DEBUG"] {
        let mut row = record(1, level);
        row.content = Some(serde_json::json!("body ".repeat(3000)));
        log.record(row)?;
    }
    log.flush()?;
    let old = SystemTime::now() - Duration::from_hours(480);
    let mut active = Vec::new();
    for lane in ["main", "debug", "bodies"] {
        let dir = root.join("logs/agent").join(lane);
        for entry in fs::read_dir(&dir)? {
            let path = entry?.path();
            fs::OpenOptions::new()
                .write(true)
                .open(&path)?
                .set_times(fs::FileTimes::new().set_modified(old))?;
            active.push(path);
        }
        let extension = if lane == "bodies" { "zst" } else { "jsonl" };
        let stale = dir.join(format!(
            "{}-0000.{extension}",
            (chrono::Utc::now() - chrono::Duration::days(20)).format("%Y%m%dT%H%M%SZ")
        ));
        fs::write(&stale, b"\n")?;
        fs::OpenOptions::new()
            .write(true)
            .open(&stale)?
            .set_times(fs::FileTimes::new().set_modified(old))?;
    }
    log.prune()?;
    assert!(active.iter().all(|p| p.exists()));
    for lane in ["main", "debug", "bodies"] {
        assert!(fs::read_dir(root.join("logs/agent").join(lane))?.all(|e| {
            !e.unwrap().file_name().to_string_lossy().starts_with(
                &(chrono::Utc::now() - chrono::Duration::days(20))
                    .format("%Y%m%d")
                    .to_string(),
            )
        }));
    }
    log.record(record(2, "INFO"))?;
    log.record(record(3, "DEBUG"))?;
    assert_eq!(log.query(&Query::default())?.rows.len(), 4);
    log.shutdown()?;
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn logs_writer_recovers_after_transient_io_error() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let root = root();
    let log = Logger::open(&root, Config::default())?;
    let main = root.join("logs/agent/main");
    // A file where a directory is required fails on every supported platform,
    // including privileged test runners where read-only permission is ineffective.
    fs::remove_dir(&main)?;
    fs::write(&main, b"temporarily unavailable")?;
    log.record(record(1, "INFO"))?;
    log.flush()?;
    fs::remove_file(&main)?;
    assert!(log.storage()?.last_write_error.is_some());
    log.record(record(2, "INFO"))?;
    let rows = log.query(&Query::default())?.rows;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].msg, "row 2");
    assert!(log.storage()?.last_write_error.is_none());
    log.configure(Config::detailed())?;
    let debug = root.join("logs/agent/debug");
    fs::write(&debug, b"temporarily unavailable")?;
    log.record(record(3, "DEBUG"))?;
    log.flush()?;
    fs::remove_file(&debug)?;
    log.record(record(4, "INFO"))?;
    log.flush()?;
    assert!(log.storage()?.last_write_error.is_some());
    log.record(record(5, "DEBUG"))?;
    log.flush()?;
    assert!(log.storage()?.last_write_error.is_none());
    log.shutdown()?;
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn logs_export_filters_records_and_rebuilds_offsets() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let root = root();
    let log = Logger::open(&root, Config::default())?;
    for n in 1..=3 {
        log.record(record(n, "INFO"))?;
    }
    let export = log.export(
        Some(&record(2, "INFO").ts),
        Some(&record(2, "INFO").ts),
        false,
    )?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(export))?;
    let restored = root.join("restored/logs");
    archive.extract(&restored)?;
    let log2 = Logger::open(&root.join("restored"), Config::default())?;
    let rows = log2.query(&Query::default())?.rows;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].msg, "row 2");
    log2.shutdown()?;
    log.shutdown()?;
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn logs_body_references_require_bounded_frame() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let root = root();
    let log = Logger::open(&root, Config::full())?;
    let dir = root.join("logs/agent/bodies");
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!(
        "{}-0000.zst",
        chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
    ));
    let compressed = zstd::encode_all(std::io::repeat(b'x').take(16 * 1024 * 1024 + 1), 1)?;
    fs::write(&path, &compressed)?;
    let name = path.file_name().unwrap().to_str().unwrap();
    assert_eq!(
        log.body(name).unwrap_err().kind(),
        std::io::ErrorKind::InvalidInput
    );
    assert_eq!(
        log.body(&format!("{name}:0:{}", compressed.len()))
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::InvalidData
    );
    log.shutdown()?;
    fs::remove_dir_all(root)?;
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn logs_error_burst_keeps_runtime_responsive() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let root = root();
    let log = Logger::open(&root, Config::default())?;
    let start = Instant::now();
    let producer = log.clone();
    let task = tokio::spawn(async move {
        for n in 0..1000 {
            producer.record(record(n, "ERROR"))?;
        }
        Ok::<_, std::io::Error>(())
    });
    tokio::task::yield_now().await;
    task.await??;
    let reader = log.clone();
    tokio::task::spawn_blocking(move || reader.flush()).await??;
    let elapsed = start.elapsed();
    let syncs = log.sync_count()?;
    let rows = super::walk(&log, Query::default());
    assert_eq!(rows.len(), 1000);
    for (n, row) in rows.iter().enumerate() {
        assert_eq!(row.msg, format!("row {}", 999 - n));
    }
    assert!(
        syncs < 2000,
        "ERROR records must share batch fsyncs: {syncs}"
    );
    eprintln!(
        "LOG-ERROR-BURST rows=1000 wall_ms={:.3} fsync_count={syncs}",
        elapsed.as_secs_f64() * 1000.0
    );
    log.shutdown()?;
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn logs_expiry_reverts_before_cleanup_and_retries() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let root = root();
    let log = Logger::open(&root, Config::full())?;
    let mut row = record(1, "TRACE");
    row.content = Some(serde_json::json!("body ".repeat(3000)));
    log.record(row)?;
    log.flush()?;
    let blocked = root.join("logs/app/bodies");
    fs::create_dir_all(blocked.parent().unwrap())?;
    // A regular file in place of the directory causes a portable deletion error.
    fs::write(&blocked, b"blocked")?;
    log.expire_full()?;
    log.flush()?;
    assert_eq!(log.config().effective, Config::default());
    assert!(!log.enabled("turn", "TRACE"));
    assert!(log.config().full_expires_at.is_none());
    assert!(blocked.is_file());
    let mut row = record(2, "INFO");
    row.content = Some(serde_json::json!("body ".repeat(3000)));
    log.record(row)?;
    let rows = log.query(&Query::default())?.rows;
    assert_eq!(rows.len(), 1);
    assert!(rows[0].body_ref.is_none() && rows[0].content.is_none());
    // Failed attempts at 1 s and 3 s schedule the next attempt at 7 s.
    std::thread::sleep(Duration::from_millis(3300));
    fs::remove_file(&blocked)?;
    fs::create_dir(&blocked)?;
    fs::write(blocked.join("pending.zst"), b"pending cleanup")?;
    std::thread::sleep(Duration::from_millis(1200));
    assert!(blocked.exists(), "cleanup must back off while idle");
    let start = Instant::now();
    while blocked.exists() && start.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!blocked.exists());
    log.shutdown()?;
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn logs_export_skips_corruption_and_reports_count() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    use std::io::{Seek, SeekFrom, Write};
    let root = root();
    let log = Logger::open(&root, Config::default())?;
    for n in 1..=4 {
        log.record(record(n, "INFO"))?;
    }
    log.flush()?;
    let path = fs::read_dir(root.join("logs/agent/main"))?
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .unwrap();
    let bytes = fs::read(&path)?;
    let offset = bytes.iter().position(|b| *b == b'\n').unwrap() + 1;
    let mut file = fs::OpenOptions::new().write(true).open(&path)?;
    file.seek(SeekFrom::Start(offset as u64))?;
    file.write_all(b"!")?;
    let next = offset + bytes[offset..].iter().position(|b| *b == b'\n').unwrap() + 1;
    file.seek(SeekFrom::Start(next as u64))?;
    file.write_all(b"\xff")?;
    drop(file);
    let expected = log.query(&Query::default())?.rows;
    assert_eq!(expected.len(), 2);
    let bytes = log.export(None, None, false)?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
    let manifest: serde_json::Value = serde_json::from_reader(archive.by_name("manifest.json")?)?;
    assert_eq!(manifest["skipped_lines"], 2);
    let restored = root.join("restored");
    archive.extract(restored.join("logs"))?;
    let restored_log = Logger::open(&restored, Config::default())?;
    let rows = restored_log.query(&Query::default())?.rows;
    assert_eq!(serde_json::to_value(rows)?, serde_json::to_value(expected)?);
    restored_log.shutdown()?;
    log.shutdown()?;
    fs::remove_dir_all(root)?;
    Ok(())
}
