//! Reading the legacy memory files: sizes and ages, JSONL and SQLite row counts, vector stats, registered projects and project refresh failures.

use super::*;

pub(super) fn scan_files(
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

pub(super) fn system_time_millis(time: Option<std::time::SystemTime>) -> Option<i64> {
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

pub(super) fn count_jsonl(path: &Path) -> usize {
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
pub(super) struct VectorStatsFile {
    #[serde(default, deserialize_with = "crate::lenient::option")]
    row_count: Option<f64>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    updated_at: Option<String>,
}

pub(super) fn read_vector_stats(path: &Path) -> VectorStats {
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

pub(super) fn count_sqlite_rows(path: &Path, table: &'static str) -> i64 {
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

pub(super) fn read_registered_projects(path: &Path) -> Vec<String> {
    let Ok(config) = fs::read(path) else {
        return Vec::new();
    };
    crate::cognition::registered_project_names(&config)
        .into_iter()
        .filter(|name| !butler_core::public_text::trim_js_whitespace(name).is_empty())
        .collect()
}

pub(super) fn sanitize_project_memory_id(project_id: &str) -> String {
    project_id.replace(['/', '\\', '\0'], "_")
}

/// A line of `projects/.refresh-failures.jsonl`.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RefreshFailure {
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
pub(super) fn read_project_failures(path: &Path) -> ProjectFailures {
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
