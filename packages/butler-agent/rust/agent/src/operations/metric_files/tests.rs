use super::*;

use crate::context::PruneToolOutputResult;
use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::sync::{
    Arc, Barrier,
    atomic::{AtomicUsize, Ordering},
};
use std::thread;

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("butler-metric-files-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn retention_drops_bad_and_old_rows_and_marks_kept_rows_private() {
    let scratch = Scratch::new();
    let files = MetricFiles::new(scratch.0.clone());
    let path = scratch.0.join("metrics/context-monitor.jsonl");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        concat!(
            "\n  \t\r\n",
            "\u{00a0}\n",
            "not-json\n",
            "{\"kind\":\"missing\"}\n",
            "{\"ts\":null}\n",
            "{\"ts\":1e999}\n",
            "{\"ts\":899,\"kind\":\"old\"}\n",
            "{\"ts\":900,\"kind\":\"boundary\"}\n",
            "{\"ts\":950,\"kind\":\"keep\"}\n",
            "{\"ts\":950,\"kind\":\"reset\",\"rawTextStored\":true}\n",
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    let result = files.retain(1_000.0, 100.0).unwrap();
    assert_eq!(
        result.for_file(MetricFile::ContextMonitor).stats,
        MetricRetentionStats {
            scanned: 8,
            kept: 3,
            deleted: 1,
            parse_errors: 4,
        }
    );
    assert_eq!(
        result.totals,
        MetricRetentionStats {
            scanned: 8,
            kept: 3,
            deleted: 1,
            parse_errors: 4,
        }
    );

    let rows: Vec<Value> = BufReader::new(File::open(&path).unwrap())
        .lines()
        .map(|line| serde_json::from_str(&line.unwrap()).unwrap())
        .collect();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["kind"], "boundary");
    assert_eq!(rows[0]["rawTextStored"], false);
    assert_eq!(rows[1]["kind"], "keep");
    assert_eq!(rows[1]["rawTextStored"], false);
    assert_eq!(rows[2]["kind"], "reset");
    assert_eq!(rows[2]["rawTextStored"], false);
}

#[test]
fn prune_observer_appends_the_existing_metric_shape() {
    let scratch = Scratch::new();
    let files = MetricFiles::new(scratch.0.clone());
    let result = PruneToolOutputResult {
        scanned: 3,
        deleted: 1,
        bytes_deleted: 40,
        remaining_bytes: 60,
        max_age_ms: 30.0,
        max_bytes: 100.0,
    };

    files.observe_prune(1_234.5, &result, 2).unwrap();

    let content = fs::read_to_string(scratch.0.join("metrics/tool-output-prune.jsonl")).unwrap();
    assert_eq!(
        content,
        concat!(
            "{\"schema\":\"butler.tool-output-prune.v1\",\"ts\":1234.5,",
            "\"scanned\":3,\"deleted\":1,\"bytesDeleted\":40,",
            "\"remainingBytes\":60,\"maxAgeMs\":30.0,\"maxBytes\":100.0,",
            "\"protectedCount\":2,\"rawTextStored\":false}\n"
        )
    );
}

#[test]
fn concurrent_append_and_retention_preserve_every_record() {
    const WRITERS: usize = 4;
    const ROWS_PER_WRITER: usize = 120;
    let scratch = Scratch::new();
    let files = Arc::new(MetricFiles::new(scratch.0.clone()));
    let barrier = Arc::new(Barrier::new(WRITERS + 2));
    let completed = Arc::new(AtomicUsize::new(0));
    let mut writers = Vec::new();

    for writer_id in 0..WRITERS {
        let files = Arc::clone(&files);
        let barrier = Arc::clone(&barrier);
        let completed = Arc::clone(&completed);
        writers.push(thread::spawn(move || {
            barrier.wait();
            for sequence in 0..ROWS_PER_WRITER {
                let row =
                    format!("{{\"ts\":1000,\"writer\":{writer_id},\"sequence\":{sequence}}}\n");
                files
                    .append(MetricFile::ContextCompaction, row.as_bytes())
                    .unwrap();
            }
            completed.fetch_add(1, Ordering::Release);
        }));
    }

    let retaining_files = Arc::clone(&files);
    let retaining_barrier = Arc::clone(&barrier);
    let retention = thread::spawn(move || {
        retaining_barrier.wait();
        for _ in 0..32 {
            retaining_files
                .retain(1_000.0, 90.0 * 24.0 * 60.0 * 60.0 * 1_000.0)
                .unwrap();
            thread::yield_now();
        }
    });

    barrier.wait();
    for writer in writers {
        writer.join().unwrap();
    }
    retention.join().unwrap();
    assert_eq!(completed.load(Ordering::Acquire), WRITERS);
    let summary = files
        .retain(1_000.0, 90.0 * 24.0 * 60.0 * 60.0 * 1_000.0)
        .unwrap();
    assert_eq!(
        summary.for_file(MetricFile::ContextCompaction).stats.kept,
        WRITERS * ROWS_PER_WRITER
    );

    let path = scratch.0.join("metrics/context-compaction.jsonl");
    let rows: Vec<Value> = BufReader::new(File::open(path).unwrap())
        .lines()
        .map(|line| serde_json::from_str(&line.unwrap()).unwrap())
        .collect();
    let ids: HashSet<_> = rows
        .iter()
        .map(|row| {
            (
                row["writer"].as_u64().unwrap(),
                row["sequence"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(rows.len(), WRITERS * ROWS_PER_WRITER);
    assert_eq!(ids.len(), rows.len());
}
