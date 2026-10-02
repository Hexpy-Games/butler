//! Inspecting a rebuild candidate: its graph counts, vector counts and typed cursor, read without taking the writer lock.

use super::*;
use butler_platform::sqlite;
use rusqlite::Connection;

/// Vector unit counts of a candidate graph.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct VectorCounts {
    /// Units with a stored vector.
    pub complete: usize,
    /// Units queued or running.
    pub pending: usize,
    /// Units that failed.
    pub failed: usize,
}

/// Read-only status of a rebuild candidate, as `memory rebuild inspect`
/// prints it. Counts are `None` when the candidate graph is missing.
#[derive(Clone, Debug, Serialize)]
pub struct RebuildInspection {
    /// The stored manifest.
    pub manifest: GenerationManifest,
    /// The candidate graph file.
    pub graph_path: PathBuf,
    /// True when the graph is unavailable.
    pub degraded: bool,
    /// Why the candidate is degraded.
    pub reason: Option<&'static str>,
    /// Projection jobs in the graph.
    pub jobs: Option<usize>,
    /// Sources registered in the graph.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registered_sources: Option<usize>,
    /// Last typed source the build registered for this snapshot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub typed_cursor: Option<Option<String>>,
    /// Semantic projection window counts.
    pub windows: Option<SemanticCounts>,
    /// Vector unit counts.
    pub vectors: Option<VectorCounts>,
    /// Hot-cache job counts.
    pub cache: Option<StageCounts>,
}

impl RebuildInspection {
    /// Whether any projection stage is unavailable, pending, or failed.
    pub fn projection_pending(&self) -> bool {
        let (Some(windows), Some(vectors), Some(cache)) = (self.windows, self.vectors, self.cache)
        else {
            return true;
        };
        self.degraded
            || windows.pending > 0
            || windows.failed > 0
            || vectors.pending > 0
            || vectors.failed > 0
            || cache.pending > 0
            || cache.failed > 0
    }
}

/// Reads a candidate's manifest and graph status without taking the write gate.
pub fn inspect(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    generation_id: &str,
) -> CognitionResult<RebuildInspection> {
    if generation_id.len() != 36
        || !generation_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-')
    {
        return Err(error(CognitionCode::MemoryGenerationVersionUnsupported));
    }
    let root = environment
        .memory_root(data_root)
        .join("generations")
        .join(generation_id);
    let graph = root.join("graph.sqlite");
    let manifest_path = root.join("manifest.json");
    ensure_data_authority(data_root, &[&root, &graph, &manifest_path])?;
    let manifest =
        GenerationManifest::read(&manifest_path, CognitionCode::MemoryGenerationUnavailable)?;
    if !manifest.is_for(generation_id) {
        return Err(error(CognitionCode::MemoryGenerationVersionUnsupported));
    }
    if !graph.is_file() {
        return Ok(RebuildInspection {
            manifest,
            graph_path: graph,
            degraded: true,
            reason: Some("graph_unavailable"),
            jobs: None,
            registered_sources: None,
            typed_cursor: None,
            windows: None,
            vectors: None,
            cache: None,
        });
    }
    let db = sqlite::open_with_flags(&graph, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))?;
    let counts = GraphCounts(&db);
    let typed_cursor = stored_typed_cursor(&db, manifest.canonical_snapshot_id.as_deref())?;
    Ok(RebuildInspection {
        jobs: Some(counts.count("SELECT COUNT(*) FROM memory_projection_jobs")?),
        registered_sources: Some(counts.count("SELECT COUNT(*) FROM memory_chunk_sources")?),
        typed_cursor: Some(typed_cursor),
        windows: Some(counts.windows()?),
        vectors: Some(counts.vectors()?),
        cache: Some(counts.cache()?),
        manifest,
        graph_path: graph,
        degraded: false,
        reason: None,
    })
}

/// The typed cursor stored for `snapshot_id`; a cursor from an older snapshot
/// does not apply.
pub(super) fn stored_typed_cursor(
    db: &Connection,
    snapshot_id: Option<&str>,
) -> CognitionResult<Option<String>> {
    #[derive(serde::Deserialize)]
    struct StoredCursor {
        #[serde(default, deserialize_with = "crate::lenient::option")]
        snapshot_id: Option<String>,
        #[serde(default, deserialize_with = "crate::lenient::option")]
        source_key: Option<String>,
    }
    let stored: Option<String> = db
        .query_row(
            "SELECT value FROM memory_state WHERE key='rebuild_typed_cursor'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|source| error(CognitionCode::MemoryGenerationUnavailable).with_source(source))?;
    Ok(stored
        .and_then(|value| serde_json::from_str::<StoredCursor>(&value).ok())
        .filter(|cursor| cursor.snapshot_id.as_deref() == snapshot_id)
        .and_then(|cursor| cursor.source_key))
}

/// Status counts read from a candidate graph.
pub(super) struct GraphCounts<'a>(&'a Connection);

impl GraphCounts<'_> {
    pub(super) fn count(&self, sql: &str) -> CognitionResult<usize> {
        let count: i64 = self
            .0
            .query_row(sql, [], |row| row.get(0))
            .map_err(|source| {
                error(CognitionCode::MemoryGenerationUnavailable).with_source(source)
            })?;
        Ok(usize::try_from(count).unwrap_or(0))
    }

    pub(super) fn windows(&self) -> CognitionResult<SemanticCounts> {
        let state = |filter: &str| {
            self.count(&format!(
                "SELECT COUNT(*) FROM memory_projection_windows WHERE state{filter}"
            ))
        };
        Ok(SemanticCounts {
            complete: state("='complete'")?,
            unsupported: state("='unsupported'")?,
            pending: state(" IN ('pending','planned','running')")?,
            failed: state("='failed'")?,
        })
    }

    pub(super) fn vectors(&self) -> CognitionResult<VectorCounts> {
        let state = |filter: &str| {
            self.count(&format!(
                "SELECT COUNT(*) FROM memory_vector_units WHERE state{filter}"
            ))
        };
        Ok(VectorCounts {
            complete: state("='complete'")?,
            pending: state(" IN ('pending','running')")?,
            failed: state("='failed'")?,
        })
    }

    pub(super) fn cache(&self) -> CognitionResult<StageCounts> {
        let state = |filter: &str| {
            self.count(&format!(
                "SELECT COUNT(*) FROM memory_projection_jobs WHERE json_extract(hot_cache_state,'$.state'){filter}"
            ))
        };
        Ok(StageCounts {
            complete: state("='complete'")?,
            pending: state(" IN ('pending','running','partial')")?,
            failed: state("='failed'")?,
            not_configured: state("='not_configured'")?,
        })
    }
}
