//! Producer flood through the production queue; a paused writer makes accounting exact.
use super::{record, root, walk};
use butler_log::{Config, Logger, Query, Record};
use std::{
    fs,
    time::{Duration, Instant},
};

#[test]
fn logs_flood_is_bounded_counted_and_reserves_errors() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let root = root();
    let log = Logger::open(&root, Config::default())?;
    let paused = log.pause_writer()?;
    let start = Instant::now();
    for n in 0..9000 {
        let level = if n % 2 == 0 { "INFO" } else { "WARN" };
        let mut row = record(n, level);
        row.msg = "x".repeat(8192);
        log.record(row)?;
        if n % 90 == 0 {
            log.record(record(n, "ERROR"))?;
        }
    }
    let producer = start.elapsed();
    let (queued, peak, dropped) = log.queue_stats();
    assert!(queued <= 40 * 1024 * 1024 && peak <= 40 * 1024 * 1024);
    assert_eq!(dropped[0], 0);
    assert!(dropped[1] > 0 && dropped[2] > 0);
    butler_e2e::assert_wall_clock_budget!(producer, Duration::from_secs(10), "LOG-FLOOD-PRODUCER");
    drop(paused);
    log.flush()?;
    let rows = walk(&log, Query::default());
    assert_eq!(rows.iter().filter(|r| r.level == "ERROR").count(), 100);
    let errors: Vec<_> = rows
        .iter()
        .filter(|r| r.level == "ERROR")
        .map(|r| r.msg.clone())
        .collect();
    let expected: Vec<_> = (0..9000)
        .step_by(90)
        .rev()
        .map(|n| format!("row {n}"))
        .collect();
    assert_eq!(errors, expected);
    assert_eq!(
        rows.iter().filter(|r| r.level == "INFO").count(),
        4500 - dropped[2]
    );
    assert_eq!(
        rows.iter()
            .filter(|r| r.level == "WARN" && r.event != "logs.dropped")
            .count(),
        4500 - dropped[1]
    );
    let warnings: Vec<_> = rows.iter().filter(|r| r.event == "logs.dropped").collect();
    assert_eq!(warnings.len(), 1);
    assert_eq!(
        warnings[0].msg,
        format!(
            "dropped {} records (queue full)",
            dropped.iter().sum::<usize>()
        )
    );
    assert_eq!(
        warnings[0].attrs["dropped"],
        serde_json::json!({"ERROR":dropped[0],"WARN":dropped[1],"INFO":dropped[2]})
    );
    assert_eq!(log.queue_stats().0, 0);
    eprintln!(
        "LOG-FLOOD max_queued_bytes={peak} dropped_error={} dropped_warn={} dropped_info={} producer_ms={:.3}",
        dropped[0],
        dropped[1],
        dropped[2],
        producer.as_secs_f64() * 1000.0
    );
    log.shutdown()?;
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn logs_error_reserve_exhaustion_is_counted() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let root = root();
    let log = Logger::open(&root, Config::default())?;
    let paused = log.pause_writer()?;
    for _ in 0..6000 {
        log.record(Record::new("ERROR", "turn", "error", &"x".repeat(8192)))?;
    }
    let (queued, peak, dropped) = log.queue_stats();
    assert!(queued > 32 * 1024 * 1024 && peak <= 40 * 1024 * 1024);
    assert!(dropped[0] > 0);
    assert_eq!(&dropped[1..], &[0, 0]);
    drop(paused);
    log.flush()?;
    let rows = walk(&log, Query::default());
    assert_eq!(rows.len(), 6000 - dropped[0] + 1);
    assert_eq!(rows[0].attrs["dropped"]["ERROR"], dropped[0]);
    log.shutdown()?;
    fs::remove_dir_all(root)?;
    Ok(())
}
