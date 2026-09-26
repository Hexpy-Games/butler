use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufRead, BufReader},
    path::Path,
};

use indexmap::IndexMap;
use serde_json::Value;

use crate::cognition::CognitionResult;

use super::error;

#[derive(Clone, Debug, PartialEq)]
pub(super) struct SourceQualitySummary {
    pub source_id: String,
    pub tool_name: String,
    pub event_count: usize,
    pub success_count: usize,
    pub failure_count: usize,
    pub negative_feedback_count: usize,
    pub average_freshness_score: f64,
    pub average_latency_ms: f64,
    pub score: f64,
    pub last_observed_at: Option<String>,
}

#[derive(Default)]
struct Accumulator {
    event_count: usize,
    success_count: usize,
    negative_feedback_count: usize,
    freshness_sum: f64,
    latency_sum: f64,
    last_observed_at: Option<String>,
}

pub(super) fn aggregate(root: &Path) -> CognitionResult<Vec<SourceQualitySummary>> {
    let path = root.join("source-quality.jsonl");
    let file = match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            let canonical_root =
                fs::canonicalize(root).map_err(|_| error("memory_source_quality_read_failed"))?;
            let canonical =
                fs::canonicalize(&path).map_err(|_| error("memory_source_quality_read_failed"))?;
            if !canonical.starts_with(&canonical_root) {
                return Err(error("memory_source_quality_path_unsafe"));
            }
            File::open(canonical).map_err(|_| error("memory_source_quality_read_failed"))?
        }
        Ok(_) => return Err(error("memory_source_quality_path_unsafe")),
        Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Vec::new());
        }
        Err(_) => return Err(error("memory_source_quality_read_failed")),
    };

    let mut groups: IndexMap<(String, String), Accumulator> = IndexMap::new();
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = reader
            .read_until(b'\n', &mut line)
            .map_err(|_| error("memory_source_quality_read_failed"))?;
        if read == 0 {
            break;
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        let object = value
            .as_object()
            .ok_or_else(|| error("memory_source_quality_event_invalid"))?;
        let source_id = string(object, "source_id")?;
        let tool_name = string(object, "tool_name")?;
        let success = object
            .get("success")
            .and_then(Value::as_bool)
            .ok_or_else(|| error("memory_source_quality_event_invalid"))?;
        let negative = object.get("user_feedback").and_then(Value::as_str) == Some("negative");
        let freshness = number(object, "freshness_score")?;
        let latency = number(object, "latency_ms")?;
        let observed_at = object.get("observed_at").and_then(Value::as_str);
        let accumulator = groups.entry((tool_name, source_id)).or_default();
        accumulator.event_count += 1;
        if success {
            accumulator.success_count += 1;
        }
        if negative {
            accumulator.negative_feedback_count += 1;
        }
        accumulator.freshness_sum += freshness;
        accumulator.latency_sum += latency;
        if let Some(observed_at) = observed_at
            && accumulator
                .last_observed_at
                .as_deref()
                .is_none_or(|last| last < observed_at)
        {
            accumulator.last_observed_at = Some(observed_at.to_owned());
        }
    }

    let mut summaries = groups
        .into_iter()
        .map(|((tool_name, source_id), accumulator)| summarize(tool_name, source_id, accumulator))
        .collect::<Vec<_>>();
    summaries.sort_by(|left, right| right.score.total_cmp(&left.score));
    Ok(summaries)
}

fn summarize(
    tool_name: String,
    source_id: String,
    accumulator: Accumulator,
) -> SourceQualitySummary {
    let count = accumulator.event_count as f64;
    let average_freshness = accumulator.freshness_sum / count;
    let average_latency = accumulator.latency_sum / count;
    let success_rate = accumulator.success_count as f64 / count;
    let user_feedback_score = (1.0 - accumulator.negative_feedback_count as f64 / count).max(0.0);
    let latency_reliability = if average_latency <= 0.0 {
        1.0
    } else {
        (1.0 - average_latency / 10_000.0).clamp(0.0, 1.0)
    };
    let score = 0.30 * average_freshness
        + 0.25 * success_rate
        + 0.20 * user_feedback_score
        + 0.15
        + 0.10 * latency_reliability;
    SourceQualitySummary {
        source_id,
        tool_name,
        event_count: accumulator.event_count,
        success_count: accumulator.success_count,
        failure_count: accumulator.event_count - accumulator.success_count,
        negative_feedback_count: accumulator.negative_feedback_count,
        average_freshness_score: round3(average_freshness),
        average_latency_ms: round3(average_latency),
        score: round3(score),
        last_observed_at: accumulator.last_observed_at,
    }
}

pub(super) fn quality_score_map(summaries: &[SourceQualitySummary]) -> HashMap<String, f64> {
    let mut scores = HashMap::new();
    for summary in summaries {
        scores.insert(summary.source_id.clone(), summary.score);
    }
    scores
}

fn string(object: &serde_json::Map<String, Value>, field: &str) -> CognitionResult<String> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| error("memory_source_quality_event_invalid"))
}

fn number(object: &serde_json::Map<String, Value>, field: &str) -> CognitionResult<f64> {
    object
        .get(field)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| error("memory_source_quality_event_invalid"))
}

fn round3(value: f64) -> f64 {
    (value * 1_000.0).round() / 1_000.0
}
