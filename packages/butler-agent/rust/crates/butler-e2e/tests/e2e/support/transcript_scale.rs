//! Historical transcript bytes must stay outside settled idle and startup reads.
use butler_e2e::e2e::HarnessError;
use std::{
    fs,
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::Path,
};

pub(super) struct Expected {
    sizes: Vec<u64>,
    line: Vec<u8>,
    metric_bytes: u64,
}

pub(super) fn seed(data: &Path) -> Result<Expected, HarnessError> {
    let directory = data.join("transcripts");
    fs::create_dir_all(&directory)?;
    // A valid historical session-status record with representative metadata.
    // No matching open App turn exists; these are retained terminal history.
    let mut line = serde_json::to_vec(&serde_json::json!({
        "eventId":"historical-status", "sessionId":"historical-session",
        "kind":"session_status", "timestamp":"2026-01-01T00:00:00Z",
        "payload":{"role":"agent", "state":"closed", "reason":"completed"},
        "metadata":{"padding":"x".repeat(1800)}
    }))?;
    line.push(b'\n');
    let mut sizes = Vec::new();
    for index in 0..2440 {
        let target = if index == 0 {
            290_000_000
        } else {
            1_210_000_000 / 2439
        };
        let rows = target / line.len() as u64 + 1;
        let mut output = BufWriter::new(fs::File::create(
            directory.join(format!("history-{index:04}.jsonl")),
        )?);
        for _ in 0..rows {
            output.write_all(&line)?;
        }
        output.flush()?;
        sizes.push(rows * line.len() as u64);
    }
    eprintln!(
        "PERF-TRANSCRIPTS files={} total_bytes={} largest_bytes={}",
        sizes.len(),
        sizes.iter().sum::<u64>(),
        sizes[0]
    );
    let metric_bytes = seed_metrics(data)?;
    Ok(Expected {
        sizes,
        line,
        metric_bytes,
    })
}

pub(super) fn assert_complete(data: &Path, expected: &Expected) -> Result<(), HarnessError> {
    let directory = data.join("transcripts");
    let count = fs::read_dir(&directory)?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("history-"))
        .count();
    assert_eq!(count, expected.sizes.len());
    assert_eq!(
        fs::metadata(data.join("metrics/operational-events.jsonl"))?.len(),
        expected.metric_bytes
    );
    for (index, size) in expected.sizes.iter().enumerate() {
        let mut file = fs::File::open(directory.join(format!("history-{index:04}.jsonl")))?;
        assert_eq!(file.metadata()?.len(), *size);
        let mut first = Vec::new();
        BufReader::new(&mut file).read_until(b'\n', &mut first)?;
        assert_eq!(first, expected.line);
        file.seek(SeekFrom::End(-i64::try_from(expected.line.len()).unwrap()))?;
        let mut last = Vec::new();
        file.read_to_end(&mut last)?;
        assert_eq!(last, expected.line);
    }
    Ok(())
}

fn seed_metrics(data: &Path) -> Result<u64, HarnessError> {
    fs::create_dir_all(data.join("metrics"))?;
    let line =
        serde_json::json!({"schema":"butler.operational-event.v1", "ts":1_790_467_200_000_i64,
        "category":"maintenance", "name":"synthetic", "status":"ok", "rawTextStored":false,
        "padding":"x".repeat(240)})
        .to_string()
            + "\n";
    let mut output = BufWriter::new(fs::File::create(
        data.join("metrics/operational-events.jsonl"),
    )?);
    for _ in 0..888_000 {
        output.write_all(line.as_bytes())?;
    }
    output.flush()?;
    let bytes = line.len() as u64 * 888_000;
    eprintln!("PERF-METRICS rows=888000 bytes={bytes}");
    Ok(bytes)
}
