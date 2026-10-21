//! Independent processes exercise the public metrics owner and legacy JSONL path.
use butler_runtime::operations::MetricFiles;
use serde_json::Value;
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::Path,
    process::{Child, Command},
    time::{Duration, Instant},
};

type Result = std::result::Result<(), Box<dyn std::error::Error>>;
const ROWS: usize = 1000;

struct Producer(Child);
impl Drop for Producer {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn metric_producer() -> Result {
    butler_e2e::gate!();
    let Some(root) = std::env::var_os("METRIC_PRODUCER_ROOT") else {
        return Ok(());
    };
    let root = Path::new(&root);
    let writer = std::env::var("METRIC_PRODUCER_ID")?;
    let files = MetricFiles::new(root.to_owned());
    fs::write(root.join(format!("ready-{writer}")), b"")?;
    wait_for(&root.join("go"))?;
    for sequence in 0..ROWS {
        // This test-only counter records the actual cross-process append order.
        // Retention never takes this lock, so it still races every append.
        let counter = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("sequence.lock"))?;
        let counter = butler_platform::instance::InstanceLock::exclusive(counter)?;
        let mut file = counter.file();
        let mut bytes = [0; 8];
        if file.metadata()?.len() != 0 {
            file.read_exact(&mut bytes)?;
        }
        let ordinal = u64::from_le_bytes(bytes);
        file.seek(SeekFrom::Start(0))?;
        file.write_all(&(ordinal + 1).to_le_bytes())?;
        let line = format!(
            "{{\"ts\":1000,\"writer\":{writer},\"sequence\":{sequence},\"ordinal\":{ordinal}}}\n"
        );
        files.append_operational_event(line.as_bytes())?;
    }
    Ok(())
}

fn wait_for(path: &Path) -> Result {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "producer barrier: {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}

#[test]
fn independent_process_appends_survive_repeated_retention_in_order() -> Result {
    butler_e2e::gate!();
    let root = std::env::temp_dir().join(format!("metric-race-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("metrics"))?;
    let path = root.join("metrics/operational-events.jsonl");
    fs::write(&path, b"{\"ts\":1}\nnot-json\n")?;
    let mut producers = Vec::new();
    for writer in 0..2 {
        let log = File::create(root.join(format!("producer-{writer}.log")))?;
        producers.push(Producer(
            Command::new(std::env::current_exe()?)
                .args([
                    "metric_retention::metric_producer",
                    "--exact",
                    "--nocapture",
                ])
                .env("METRIC_PRODUCER_ROOT", &root)
                .env("METRIC_PRODUCER_ID", writer.to_string())
                .stdout(log.try_clone()?)
                .stderr(log)
                .spawn()?,
        ));
    }
    for writer in 0..2 {
        wait_for(&root.join(format!("ready-{writer}")))?;
    }
    fs::write(root.join("go"), b"")?;
    let files = MetricFiles::new(root.clone());
    let mut deleted = 0;
    for _ in 0..64 {
        deleted += files.retain(1000.0, 100.0)?.totals.deleted;
        std::thread::yield_now();
    }
    for producer in &mut producers {
        assert!(producer.0.wait()?.success());
    }
    deleted += files.retain(1000.0, 100.0)?.totals.deleted;
    assert_eq!(deleted, 1);
    let mut sequences = [Vec::new(), Vec::new()];
    for (ordinal, line) in BufReader::new(File::open(path)?).lines().enumerate() {
        let row: Value = serde_json::from_str(&line?)?;
        assert_eq!(row["ordinal"], ordinal);
        let writer = usize::try_from(row["writer"].as_u64().unwrap())?;
        sequences[writer].push(row["sequence"].as_u64().unwrap());
        assert_eq!(row["rawTextStored"], false);
    }
    for actual in sequences {
        assert_eq!(actual, (0..ROWS as u64).collect::<Vec<_>>());
    }
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn history_retention_skips_unchanged_content_until_expiry() -> Result {
    butler_e2e::gate!();
    let root = std::env::temp_dir().join(format!("metric-scale-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("metrics"))?;
    let path = root.join("metrics/operational-events.jsonl");
    let line = format!(
        "{{\"ts\":1000,\"rawTextStored\":false,\"payload\":\"{}\"}}\n",
        "x".repeat(4096)
    );
    let count = 48;
    let mut output = BufWriter::new(File::create(&path)?);
    for _ in 0..count {
        output.write_all(line.as_bytes())?;
    }
    output.flush()?;
    drop(output);
    let files = MetricFiles::new(root.clone());
    let before = fs::metadata(&path)?;
    let start = Instant::now();
    let first = files.retain(1000.0, 100.0)?;
    let initial = start.elapsed();
    assert_eq!(first.totals.kept, count);
    assert_eq!(first.totals.scanned, count);
    assert_eq!(fs::metadata(&path)?.modified()?, before.modified()?);
    let start = Instant::now();
    let idle = files.retain(1050.0, 100.0)?;
    eprintln!(
        "metric-scale bytes={} rows={count} first={initial:?} unchanged={:?}",
        before.len(),
        start.elapsed()
    );
    assert_eq!(idle.totals.scanned, 0);
    assert_eq!(idle.totals.kept, count);
    for actual in BufReader::new(File::open(&path)?).lines() {
        assert_eq!(actual?, line.trim_end());
    }
    assert_eq!(fs::metadata(&path)?.len(), before.len());
    files.append_operational_event(line.as_bytes())?;
    let appended = fs::metadata(&path)?;
    let refreshed = files.retain(1100.0, 100.0)?;
    assert_eq!(refreshed.totals.kept, count + 1);
    assert_eq!(refreshed.totals.scanned, count + 1);
    assert_eq!(fs::metadata(&path)?.modified()?, appended.modified()?);
    let expired = files.retain(1101.0, 100.0)?;
    assert_eq!(expired.totals.deleted, count + 1);
    assert_eq!(expired.totals.kept, 0);
    assert_eq!(fs::metadata(&path)?.len(), 0);
    fs::remove_dir_all(root)?;
    Ok(())
}
