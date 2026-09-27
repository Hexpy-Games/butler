//! The legacy file-based memory stores, the serving generation and the
//! writer lock, gathered into one [`MemoryHealthReport`].

use std::{
    collections::HashSet,
    fs::{self, File},
    io::{BufRead, BufReader},
    path::Path,
};

use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;

use crate::cognition::{CognitionPathEnvironment, CognitionResult};
use crate::coordination::{CognitionWriteCoordinator, ConsolidationLockState};
use butler_core::js_date;

use super::maintenance::MaintenanceState;
use super::report::{HealthDimensions, HealthSummary, ServingHealth, WriterGate};
use super::{MaintenanceStatus, MemoryHealthReport, error, maintenance};
use crate::cognition::CognitionCode;
use crate::profile::ProfileCoverageHealth;

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

/// Whether a file scan also records the file stems.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Stems {
    Collect,
    Skip,
}

/// Counts and times of the legacy file-based memory stores.
struct LegacyStores {
    hot_cache_files: usize,
    rule_files: usize,
    transcript_files: usize,
    task_memory_entries: usize,
    project_capsules: usize,
    missing_projects: usize,
    newest_project_capsule_ms: Option<i64>,
    project_failures: ProjectFailures,
    queue_backlog: usize,
    dead_letter_count: usize,
    vector_stats: VectorStats,
    memory_chunks: i64,
    graph_entities: i64,
    graph_edges: i64,
    graph_mentions: i64,
    newest_hot_cache_ms: Option<i64>,
    ingestion_lag_ms: Option<i64>,
    stale: bool,
}

/// The whole report: legacy stores, maintenance, the writer lock and the
/// serving generation (with the profile coverage, when given).
pub(super) fn read(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    coordinator: &CognitionWriteCoordinator,
    now: i64,
    profile: Option<&ProfileCoverageHealth>,
) -> CognitionResult<MemoryHealthReport> {
    let stores = LegacyStores::read(data_root, paths, now)?;
    let maintenance =
        maintenance::read(&paths.cognition_root(data_root).join("consolidation"), now)?;
    let diagnostics = diagnostics(&stores, &maintenance);
    let gate = writer_gate(coordinator, &paths.consolidation_lock(data_root));
    let serving = super::serving::read(data_root, paths, now, profile);
    let maintenance_status = maintenance.status;
    Ok(MemoryHealthReport {
        memory_chunks_count: stores.memory_chunks,
        vector_rows_count: stores.vector_stats.count,
        maintenance_status,
        diagnostics_count: diagnostics.len(),
        dimensions: dimensions(&stores, &maintenance, &serving, &gate),
        metric_status: if maintenance_status == MaintenanceStatus::Failed {
            "error"
        } else {
            "ok"
        },
        summary: summary(stores, maintenance, serving, gate, diagnostics),
    })
}

impl LegacyStores {
    fn read(data_root: &Path, paths: &CognitionPathEnvironment, now: i64) -> CognitionResult<Self> {
        let memory_root = paths.memory_root(data_root);
        let hot = scan_files(&memory_root.join("hot"), ".md", None, Stems::Skip)?;
        let hot_topics = scan_files(&memory_root.join("hot/topics"), ".md", None, Stems::Skip)?;
        let rules = scan_files(
            &memory_root.join("rules"),
            ".md",
            Some("INDEX.md"),
            Stems::Skip,
        )?;
        let transcripts = scan_files(&data_root.join("transcripts"), ".jsonl", None, Stems::Skip)?;
        let task_entries = scan_files(&memory_root.join("tasks"), ".md", None, Stems::Skip)?;
        let projects = scan_files(&memory_root.join("projects"), ".md", None, Stems::Collect)?;
        let missing_projects = read_registered_projects(&data_root.join("butler.config.json"))
            .iter()
            .filter(|name| !projects.stems.contains(&sanitize_project_memory_id(name)))
            .count();
        let vector_stats = read_vector_stats(&memory_root.join("db/vector-stats.json"));
        let graph = memory_root.join("db/graph.sqlite");
        let newest_hot_cache_ms = max_option(hot.newest_mtime_ms, hot_topics.newest_mtime_ms);
        let ingestion_lag_ms = match (transcripts.newest_mtime_ms, vector_stats.updated_at_ms) {
            (Some(transcript), Some(vector)) if transcript != 0 && vector != 0 => {
                Some(transcript.saturating_sub(vector).max(0))
            }
            _ => None,
        };
        Ok(Self {
            hot_cache_files: hot.count + hot_topics.count,
            rule_files: rules.count,
            transcript_files: transcripts.count,
            task_memory_entries: task_entries.count,
            project_capsules: projects.count,
            missing_projects,
            newest_project_capsule_ms: projects.newest_mtime_ms,
            project_failures: read_project_failures(
                &memory_root.join("projects").join(".refresh-failures.jsonl"),
            ),
            queue_backlog: count_jsonl(&memory_root.join("queue/sync.jsonl")),
            dead_letter_count: count_jsonl(&memory_root.join("queue/dead-letter.jsonl")),
            vector_stats,
            memory_chunks: count_sqlite_rows(&memory_root.join("metadata.sqlite"), "memory_chunks"),
            graph_entities: count_sqlite_rows(&graph, "memory_nodes"),
            graph_edges: count_sqlite_rows(&graph, "edges"),
            graph_mentions: count_sqlite_rows(&graph, "memory_evidence"),
            newest_hot_cache_ms,
            ingestion_lag_ms,
            stale: newest_hot_cache_ms
                .is_none_or(|updated| now.saturating_sub(updated) > STALE_AFTER_MS),
        })
    }
}

/// Human-readable problems, in the source's order.
fn diagnostics(stores: &LegacyStores, maintenance: &MaintenanceState) -> Vec<String> {
    let mut diagnostics = Vec::new();
    if stores.stale {
        diagnostics.push("hot cache is stale or missing".into());
    }
    if stores.queue_backlog > 0 {
        diagnostics.push(format!(
            "{} memory sync request(s) are queued",
            stores.queue_backlog
        ));
    }
    if stores.dead_letter_count > 0 {
        diagnostics.push(format!(
            "{} memory sync request(s) are in dead-letter",
            stores.dead_letter_count
        ));
    }
    if stores.missing_projects > 0 {
        diagnostics.push(format!(
            "{} registered project capsule(s) are missing",
            stores.missing_projects
        ));
    }
    if stores.project_failures.count > 0 {
        diagnostics.push(format!(
            "{} project capsule refresh failure(s) recorded",
            stores.project_failures.count
        ));
    }
    if stores.vector_stats.count.is_none() {
        diagnostics.push("vector row count is unavailable until the first successful index".into());
    }
    if stores.graph_entities == 0 && stores.graph_edges == 0 && stores.graph_mentions == 0 {
        diagnostics.push("graph memory has no indexed associations yet".into());
    }
    if let Some(lag) = stores.ingestion_lag_ms.filter(|lag| *lag > 60 * 60 * 1_000) {
        let minutes = butler_core::json::saturating_i64((lag as f64 / 60_000.0).round());
        diagnostics.push(format!("memory ingestion lag is {minutes} minute(s)"));
    }
    diagnostics.extend(maintenance.diagnostics.iter().cloned());
    diagnostics
}

/// The consolidation lock as the coordinator inspects it (unavailable when
/// inspection fails).
fn writer_gate(coordinator: &CognitionWriteCoordinator, lock_path: &Path) -> WriterGate {
    match coordinator.inspect(lock_path) {
        Ok(inspection) => WriterGate {
            state: lock_state_name(inspection.state),
            pid: inspection.pid,
            owner: inspection.owner,
            last_observed_owner: inspection.last_observed_owner,
            coordinator_path: inspection.coordinator_path,
            reason: inspection.reason,
        },
        Err(_) => WriterGate {
            state: "unavailable",
            pid: None,
            owner: None,
            last_observed_owner: None,
            coordinator_path: std::path::PathBuf::from(format!(
                "{}.coord.sqlite",
                lock_path.display()
            )),
            reason: Some("coordinator_unavailable"),
        },
    }
}

fn dimensions(
    stores: &LegacyStores,
    maintenance: &MaintenanceState,
    serving: &ServingHealth,
    gate: &WriterGate,
) -> HealthDimensions {
    HealthDimensions {
        hot_cache_files_count: stores.hot_cache_files,
        rule_files_count: stores.rule_files,
        queue_backlog_count: stores.queue_backlog,
        dead_letter_count: stores.dead_letter_count,
        transcript_files_count: stores.transcript_files,
        task_memory_entries_count: stores.task_memory_entries,
        project_capsules_count: stores.project_capsules,
        missing_project_capsules_count: stores.missing_projects,
        vector_rows_count: stores.vector_stats.count,
        memory_chunks_count: stores.memory_chunks,
        graph_entities_count: stores.graph_entities,
        graph_edges_count: stores.graph_edges,
        graph_mentions_count: stores.graph_mentions,
        ingestion_lag_ms: stores.ingestion_lag_ms,
        stale: stores.stale,
        maintenance_failed_phases_count: maintenance.failed_phases.len(),
        serving_available: serving.available,
        eligible_sources_count: serving.sources.eligible,
        registered_sources_count: serving.sources.registered,
        unknown_origin_excluded_count: serving.sources.unknown_origin_excluded,
        source_coverage_percent: serving.sources.coverage_percent,
        oldest_pending_age_ms: serving.oldest_pending_age_ms,
        source_resolution_failures_count: serving.source_resolution_failures,
        embedding_version_mismatch_count: serving.embedding_version_mismatch,
        cache_stale_entries_count: serving.cache.stale_entries,
        cache_evicted_entries_count: serving.cache.evicted_entries,
        profile_processed_windows_count: serving
            .profile
            .as_ref()
            .map(|profile| profile.processed_windows),
        profile_pending_windows_count: serving
            .profile
            .as_ref()
            .map(|profile| profile.pending_windows),
        maintenance_last_run_at: maintenance.last_run_at.clone(),
        maintenance_failed_phases: maintenance.failed_phases.clone(),
        writer_gate_status: gate.state,
        writer_gate_reason: gate.reason,
    }
}

fn summary(
    stores: LegacyStores,
    maintenance: MaintenanceState,
    serving: ServingHealth,
    gate: WriterGate,
    diagnostics: Vec<String>,
) -> HealthSummary {
    let to_iso = |time: Option<i64>| {
        time.and_then(|ms| {
            chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
                .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        })
    };
    HealthSummary {
        serving,
        writer_gate: gate,
        hot_cache_files: stores.hot_cache_files,
        rule_files: stores.rule_files,
        queue_backlog: stores.queue_backlog,
        dead_letter_count: stores.dead_letter_count,
        transcript_files: stores.transcript_files,
        task_memory_entries: stores.task_memory_entries,
        project_capsules: stores.project_capsules,
        missing_project_capsules: stores.missing_projects,
        newest_project_capsule_at: to_iso(stores.newest_project_capsule_ms),
        project_refresh_failure_count: stores.project_failures.count,
        latest_project_refresh_failure_at: stores.project_failures.latest_at,
        vector_row_count: stores.vector_stats.count,
        memory_chunk_count: stores.memory_chunks,
        graph_entity_count: stores.graph_entities,
        graph_edge_count: stores.graph_edges,
        graph_mention_count: stores.graph_mentions,
        ingestion_lag_ms: stores.ingestion_lag_ms,
        newest_hot_cache_at: to_iso(stores.newest_hot_cache_ms),
        maintenance_status: maintenance.status.as_str(),
        maintenance_last_run_at: maintenance.last_run_at,
        maintenance_failed_phases: maintenance.failed_phases,
        stale: stores.stale,
        diagnostics,
    }
}

fn scan_files(
    directory: &Path,
    suffix: &str,
    excluded_name: Option<&str>,
    stems: Stems,
) -> CognitionResult<FileStats> {
    let rows = match fs::read_dir(directory) {
        Ok(rows) => rows,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileStats::default());
        }
        Err(_) => return Err(error(CognitionCode::MemoryHealthReadFailed)),
    };
    let mut stats = FileStats::default();
    for row in rows {
        let row =
            row.map_err(|source| error(CognitionCode::MemoryHealthReadFailed).with_source(source))?;
        let name = row.file_name();
        let name = name.to_string_lossy();
        if !name.ends_with(suffix) || excluded_name == Some(name.as_ref()) {
            continue;
        }
        stats.count += 1;
        if stems == Stems::Collect
            && let Some(stem) = name.strip_suffix(suffix)
        {
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
        Ok(duration) => {
            Some(i64::try_from(duration.as_millis().min(i64::MAX as u128)).unwrap_or(i64::MAX))
        }
        Err(error) => Some(
            -i64::try_from(error.duration().as_millis().min(i64::MAX as u128)).unwrap_or(i64::MAX),
        ),
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

/// `db/vector-stats.json` of the legacy vector index.
#[derive(Default, Deserialize)]
struct VectorStatsFile {
    #[serde(default, deserialize_with = "crate::lenient::option")]
    row_count: Option<f64>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    updated_at: Option<String>,
}

fn read_vector_stats(path: &Path) -> VectorStats {
    let file: VectorStatsFile = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .map(|value| crate::lenient::view(&value))
        .unwrap_or_default();
    VectorStats {
        count: file.row_count,
        updated_at_ms: file
            .updated_at
            .as_deref()
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
    let Ok(config) = fs::read(path) else {
        return Vec::new();
    };
    crate::cognition::registered_project_names(&config)
        .into_iter()
        .filter(|name| !butler_core::public_text::trim_js_whitespace(name).is_empty())
        .collect()
}

fn sanitize_project_memory_id(project_id: &str) -> String {
    project_id.replace(['/', '\\', '\0'], "_")
}

/// A line of `projects/.refresh-failures.jsonl`.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshFailure {
    #[serde(default, deserialize_with = "crate::lenient::option")]
    ts: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    project_id: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    phase: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    message: Option<String>,
}

/// Well-formed refresh failures (lock or refresh phase) and the last one's
/// time.
fn read_project_failures(path: &Path) -> ProjectFailures {
    let mut failures = ProjectFailures {
        count: 0,
        latest_at: None,
    };
    let Ok(file) = File::open(path) else {
        return failures;
    };
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&line) else {
            continue;
        };
        let failure: RefreshFailure = crate::lenient::view(&value);
        if failure.ts.is_none()
            || failure.project_id.is_none()
            || !matches!(failure.phase.as_deref(), Some("lock" | "refresh"))
            || failure.message.is_none()
        {
            continue;
        }
        failures.count += 1;
        failures.latest_at = failure.ts;
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
