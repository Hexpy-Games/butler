use std::{
    collections::HashSet,
    fs::{self, File},
    io::{BufRead, BufReader},
    path::Path,
};

use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};

use crate::{
    cognition::{CognitionPathEnvironment, CognitionResult},
    coordination::{CognitionWriteCoordinator, ConsolidationLockState},
    js_date,
};

use super::{MaintenanceStatus, MemoryHealthReport, error, maintenance};

const STALE_AFTER_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
#[derive(Default)]
struct FileStats {
    count: usize,
    newest_mtime_ms: Option<i64>,
    stems: HashSet<String>,
}

struct VectorStats {
    count: Option<f64>,
    updated_at_ms: Option<i64>,
}

struct ProjectFailures {
    count: usize,
    latest_at: Option<String>,
}

pub(super) fn read(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    coordinator: &CognitionWriteCoordinator,
    now: i64,
    profile: Option<Value>,
) -> CognitionResult<MemoryHealthReport> {
    let memory_root = paths.memory_root(data_root);
    let cognition_root = paths.cognition_root(data_root);
    let hot = scan_files(&memory_root.join("hot"), ".md", None, false)?;
    let hot_topics = scan_files(&memory_root.join("hot/topics"), ".md", None, false)?;
    let rules = scan_files(&memory_root.join("rules"), ".md", Some("INDEX.md"), false)?;
    let transcripts = scan_files(&data_root.join("transcripts"), ".jsonl", None, false)?;
    let task_entries = scan_files(&memory_root.join("tasks"), ".md", None, false)?;
    let projects = scan_files(&memory_root.join("projects"), ".md", None, true)?;
    let registered_projects = read_registered_projects(&data_root.join("butler.config.json"));
    let missing_projects = registered_projects
        .iter()
        .filter(|name| !projects.stems.contains(&sanitize_project_memory_id(name)))
        .count();
    let project_failures =
        read_project_failures(&memory_root.join("projects").join(".refresh-failures.jsonl"));
    let queue_backlog = count_jsonl(&memory_root.join("queue/sync.jsonl"));
    let dead_letter_count = count_jsonl(&memory_root.join("queue/dead-letter.jsonl"));
    let vector_stats = read_vector_stats(&memory_root.join("db/vector-stats.json"));
    let database_root = memory_root.join("db");
    let memory_chunks_count =
        count_sqlite_rows(&memory_root.join("metadata.sqlite"), "memory_chunks");
    let graph_entity_count = count_sqlite_rows(&database_root.join("graph.sqlite"), "memory_nodes");
    let graph_edge_count = count_sqlite_rows(&database_root.join("graph.sqlite"), "edges");
    let graph_mention_count =
        count_sqlite_rows(&database_root.join("graph.sqlite"), "memory_evidence");
    let newest_hot_cache_ms = max_option(hot.newest_mtime_ms, hot_topics.newest_mtime_ms);
    let newest_transcript_ms = transcripts.newest_mtime_ms;
    let ingestion_lag_ms = match (newest_transcript_ms, vector_stats.updated_at_ms) {
        (Some(transcript), Some(vector)) if transcript != 0 && vector != 0 => {
            Some(transcript.saturating_sub(vector).max(0))
        }
        _ => None,
    };
    let stale =
        newest_hot_cache_ms.is_none_or(|updated| now.saturating_sub(updated) > STALE_AFTER_MS);
    let maintenance = maintenance::read(&cognition_root.join("consolidation"), now)?;
    let hot_cache_files_count = hot.count + hot_topics.count;
    let project_capsules_count = projects.count;
    let mut diagnostics = Vec::new();
    if stale {
        diagnostics.push("hot cache is stale or missing".into());
    }
    if queue_backlog > 0 {
        diagnostics.push(format!("{queue_backlog} memory sync request(s) are queued"));
    }
    if dead_letter_count > 0 {
        diagnostics.push(format!(
            "{dead_letter_count} memory sync request(s) are in dead-letter"
        ));
    }
    if missing_projects > 0 {
        diagnostics.push(format!(
            "{missing_projects} registered project capsule(s) are missing"
        ));
    }
    if project_failures.count > 0 {
        diagnostics.push(format!(
            "{} project capsule refresh failure(s) recorded",
            project_failures.count
        ));
    }
    if vector_stats.count.is_none() {
        diagnostics.push("vector row count is unavailable until the first successful index".into());
    }
    if graph_entity_count == 0 && graph_edge_count == 0 && graph_mention_count == 0 {
        diagnostics.push("graph memory has no indexed associations yet".into());
    }
    if ingestion_lag_ms.is_some_and(|lag| lag > 60 * 60 * 1_000) {
        let minutes = (ingestion_lag_ms.unwrap_or_default() as f64 / 60_000.0).round() as i64;
        diagnostics.push(format!("memory ingestion lag is {minutes} minute(s)"));
    }
    diagnostics.extend(maintenance.diagnostics.iter().cloned());

    let lock_path = paths.consolidation_lock(data_root);
    let (
        writer_gate_status,
        writer_gate_reason,
        inspection_pid,
        inspection_owner,
        inspection_last,
        coordinator_path,
    ) = match coordinator.inspect(&lock_path) {
        Ok(inspection) => (
            lock_state_name(inspection.state),
            inspection.reason,
            inspection.pid,
            inspection.owner,
            inspection.last_observed_owner,
            inspection.coordinator_path,
        ),
        Err(_) => (
            "unavailable",
            Some("coordinator_unavailable"),
            None,
            None,
            None,
            std::path::PathBuf::from(format!("{}.coord.sqlite", lock_path.display())),
        ),
    };
    let diagnostics_count = diagnostics.len();
    let maintenance_status = maintenance.status;
    let metric_status = if maintenance_status == MaintenanceStatus::Failed {
        "error"
    } else {
        "ok"
    };
    let serving = super::serving::read(data_root, paths, now, profile.unwrap_or(Value::Null));
    let dimensions = json!({
        "hot_cache_files_count": hot_cache_files_count,
        "rule_files_count": rules.count,
        "queue_backlog_count": queue_backlog,
        "dead_letter_count": dead_letter_count,
        "transcript_files_count": transcripts.count,
        "task_memory_entries_count": task_entries.count,
        "project_capsules_count": project_capsules_count,
        "missing_project_capsules_count": missing_projects,
        "vector_rows_count": vector_stats.count,
        "memory_chunks_count": memory_chunks_count,
        "graph_entities_count": graph_entity_count,
        "graph_edges_count": graph_edge_count,
        "graph_mentions_count": graph_mention_count,
        "ingestion_lag_ms": ingestion_lag_ms,
        "stale": stale,
        "maintenance_failed_phases_count": maintenance.failed_phases.len(),
        "serving_available": serving["available"],
        "eligible_sources_count": serving["sources"]["eligible"],
        "registered_sources_count": serving["sources"]["registered"],
        "unknown_origin_excluded_count": serving["sources"]["unknown_origin_excluded"],
        "source_coverage_percent": serving["sources"]["coverage_percent"],
        "oldest_pending_age_ms": serving["oldest_pending_age_ms"],
        "source_resolution_failures_count": serving["source_resolution_failures"],
        "embedding_version_mismatch_count": serving["embedding_version_mismatch"],
        "cache_stale_entries_count": serving["cache"]["stale_entries"],
        "cache_evicted_entries_count": serving["cache"]["evicted_entries"],
        "profile_processed_windows_count": serving["profile"]["processed_windows"],
        "profile_pending_windows_count": serving["profile"]["pending_windows"],
        "maintenance_last_run_at": maintenance.last_run_at,
        "maintenance_failed_phases": maintenance.failed_phases,
        "writer_gate_status": writer_gate_status,
        "writer_gate_reason": writer_gate_reason,
    });
    let to_iso = |time: Option<i64>| {
        time.and_then(|ms| {
            chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
                .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        })
    };
    let summary = json!({
        "serving": serving,
        "writerGate": {
            "state": writer_gate_status,
            "pid": inspection_pid,
            "owner": inspection_owner,
            "last_observed_owner": inspection_last,
            "coordinator_path": coordinator_path,
            "reason": writer_gate_reason,
        },
        "hotCacheFiles": hot_cache_files_count,
        "ruleFiles": rules.count,
        "queueBacklog": queue_backlog,
        "deadLetterCount": dead_letter_count,
        "transcriptFiles": transcripts.count,
        "taskMemoryEntries": task_entries.count,
        "projectCapsules": project_capsules_count,
        "missingProjectCapsules": missing_projects,
        "newestProjectCapsuleAt": to_iso(projects.newest_mtime_ms),
        "projectRefreshFailureCount": project_failures.count,
        "latestProjectRefreshFailureAt": project_failures.latest_at,
        "vectorRowCount": vector_stats.count,
        "memoryChunkCount": memory_chunks_count,
        "graphEntityCount": graph_entity_count,
        "graphEdgeCount": graph_edge_count,
        "graphMentionCount": graph_mention_count,
        "ingestionLagMs": ingestion_lag_ms,
        "newestHotCacheAt": to_iso(newest_hot_cache_ms),
        "maintenanceStatus": maintenance_status.as_str(),
        "maintenanceLastRunAt": maintenance.last_run_at,
        "maintenanceFailedPhases": maintenance.failed_phases,
        "stale": stale,
        "diagnostics": diagnostics,
    });
    Ok(MemoryHealthReport {
        memory_chunks_count,
        vector_rows_count: vector_stats.count,
        maintenance_status,
        diagnostics_count,
        metric_dimensions: dimensions,
        metric_status,
        summary,
    })
}

fn scan_files(
    directory: &Path,
    suffix: &str,
    excluded_name: Option<&str>,
    collect_stems: bool,
) -> CognitionResult<FileStats> {
    let rows = match fs::read_dir(directory) {
        Ok(rows) => rows,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileStats::default());
        }
        Err(_) => return Err(error("memory_health_read_failed")),
    };
    let mut stats = FileStats::default();
    for row in rows {
        let row = row.map_err(|_| error("memory_health_read_failed"))?;
        let name = row.file_name();
        let name = name.to_string_lossy();
        if !name.ends_with(suffix) || excluded_name == Some(name.as_ref()) {
            continue;
        }
        stats.count += 1;
        if collect_stems && let Some(stem) = name.strip_suffix(suffix) {
            stats.stems.insert(stem.to_owned());
        }
        if let Ok(metadata) = fs::metadata(row.path())
            && let Some(mtime) = system_time_millis(metadata.modified().ok())
            && mtime > 0
            && stats.newest_mtime_ms.is_none_or(|newest| mtime > newest)
        {
            stats.newest_mtime_ms = Some(mtime);
        }
    }
    Ok(stats)
}

fn system_time_millis(time: Option<std::time::SystemTime>) -> Option<i64> {
    let time = time?;
    match time.duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => Some(duration.as_millis().min(i64::MAX as u128) as i64),
        Err(error) => Some(-(error.duration().as_millis().min(i64::MAX as u128) as i64)),
    }
}

fn count_jsonl(path: &Path) -> usize {
    let Ok(file) = File::open(path) else {
        return 0;
    };
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut count = 0;
    let mut seen_content = false;
    let mut pending_blank = 0;
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if line.last() == Some(&b'\n') {
            line.pop();
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            if seen_content && !line.is_empty() {
                pending_blank += 1;
            }
            continue;
        }
        if seen_content {
            count += pending_blank;
        }
        pending_blank = 0;
        seen_content = true;
        count += 1;
    }
    count
}

fn read_vector_stats(path: &Path) -> VectorStats {
    let Ok(bytes) = fs::read(path) else {
        return VectorStats {
            count: None,
            updated_at_ms: None,
        };
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return VectorStats {
            count: None,
            updated_at_ms: None,
        };
    };
    VectorStats {
        count: value.get("row_count").and_then(Value::as_f64),
        updated_at_ms: value
            .get("updated_at")
            .and_then(Value::as_str)
            .and_then(|value| js_date::parse_date_millis(value, &Some)),
    }
}

fn count_sqlite_rows(path: &Path, table: &'static str) -> i64 {
    if !path.exists() {
        return 0;
    }
    let Ok(database) = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    ) else {
        return 0;
    };
    database
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0)
}

fn read_registered_projects(path: &Path) -> Vec<String> {
    let Ok(bytes) = fs::read(path) else {
        return Vec::new();
    };
    let Ok(config) = serde_json::from_slice::<Value>(&bytes) else {
        return Vec::new();
    };
    let values = match config.get("projects") {
        Some(Value::Array(values)) => values.iter().collect::<Vec<_>>(),
        Some(Value::Object(values)) => values.values().collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    values
        .into_iter()
        .filter_map(|project| project.get("name").and_then(Value::as_str))
        .filter(|name| !crate::public_text::trim_js_whitespace(name).is_empty())
        .map(str::to_owned)
        .collect()
}

fn sanitize_project_memory_id(project_id: &str) -> String {
    project_id.replace(['/', '\\', '\0'], "_")
}

fn read_project_failures(path: &Path) -> ProjectFailures {
    let Ok(file) = File::open(path) else {
        return ProjectFailures {
            count: 0,
            latest_at: None,
        };
    };
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut failures = ProjectFailures {
        count: 0,
        latest_at: None,
    };
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if value.get("ts").and_then(Value::as_str).is_none()
            || value.get("projectId").and_then(Value::as_str).is_none()
            || !matches!(
                value.get("phase").and_then(Value::as_str),
                Some("lock" | "refresh")
            )
            || value.get("message").and_then(Value::as_str).is_none()
        {
            continue;
        }
        failures.count += 1;
        failures.latest_at = value.get("ts").and_then(Value::as_str).map(str::to_owned);
    }
    failures
}

fn max_option(left: Option<i64>, right: Option<i64>) -> Option<i64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn lock_state_name(state: ConsolidationLockState) -> &'static str {
    match state {
        ConsolidationLockState::Free => "free",
        ConsolidationLockState::InitializationAvailable => "initialization_available",
        ConsolidationLockState::Held => "held",
        ConsolidationLockState::Busy => "busy",
        ConsolidationLockState::LegacyBlocked => "legacy_blocked",
        ConsolidationLockState::Unavailable => "unavailable",
    }
}
