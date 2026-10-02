//! Active-generation serving facts from read-only Cognition and Profile owners.

use std::{
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
};

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::Deserialize;

use super::report::{STAGE_UNITS, ServingHealth, ServingSources, StageCount, Stages};
use crate::profile::ProfileCoverageHealth;

use crate::cognition::feedback::{FeedbackSourceRow, excluded_source_ids};
use crate::cognition::recall::{RecallProjectFilter, RecallRequest, RecallRuntime, RecallScope};
use crate::cognition::sources::read_canonical_inventory;
use crate::cognition::{CognitionCode, CognitionPathEnvironment, resolve_active_generation};
use butler_turn::conversation::{ConversationSourceReader, conversation_store_path};

/// The active generation's serving facts; any read failure (or the
/// generation changing underneath) reports the serving store unavailable.
pub(super) fn read(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    now: i64,
    profile: Option<&ProfileCoverageHealth>,
) -> ServingHealth {
    let Ok(handle) = resolve_active_generation(data_root, paths) else {
        return unavailable(data_root, paths, now, "generation_unavailable", profile);
    };
    let Ok(db) = Connection::open_with_flags(&handle.graph_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
        return unavailable(data_root, paths, now, "serving_store_unavailable", profile);
    };
    let Ok(Some(revision)) = graph_revision(&db) else {
        return unavailable(data_root, paths, now, "serving_store_unavailable", profile);
    };
    let read = (|| -> rusqlite::Result<ServingHealth> {
        let facts = GraphFacts::read(data_root, now, &db, &handle.generation_id)?;
        let cache =
            crate::cognition::generation::read_hot_cache_health(data_root, &handle, now, revision);
        let unchanged = resolve_active_generation(data_root, paths)
            .is_ok_and(|current| current.generation_id == handle.generation_id)
            && graph_revision(&db).ok().flatten() == Some(revision);
        if !unchanged {
            return Ok(unavailable(
                data_root,
                paths,
                now,
                "generation_changed",
                profile,
            ));
        }
        Ok(facts.into_health(handle.generation_id.clone(), revision, cache, profile))
    })();
    read.unwrap_or_else(|_| {
        unavailable(data_root, paths, now, "serving_store_unavailable", profile)
    })
}

/// What the serving graph says about its sources and work.
struct GraphFacts {
    registered: i64,
    current: i64,
    inventory: (usize, Option<f64>, &'static str),
    stages: Stages,
    oldest_age: Option<i64>,
    oldest_vector: Option<String>,
    failures: i64,
    historical_failures: i64,
    mismatch: i64,
    historical_mismatch: i64,
    pending_quality: usize,
}

impl GraphFacts {
    fn read(
        data_root: &Path,
        now: i64,
        db: &Connection,
        generation_id: &str,
    ) -> rusqlite::Result<Self> {
        let registered = count(
            db,
            "SELECT COUNT(*) FROM memory_chunk_sources WHERE source_id NOT IN (SELECT source_id FROM memory_source_split_parents)",
        )?;
        let current = count(
            db,
            "SELECT COUNT(*) FROM memory_chunk_sources s JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision WHERE c.status='active' AND NOT EXISTS(SELECT 1 FROM memory_source_split_parents p WHERE p.source_id=s.source_id) AND ((s.source_kind='conversation' AND s.origin_kind IN ('user_input','assistant_public')) OR s.source_kind IN ('task_report','explicit_record'))",
        )?;
        let inventory = inventory(data_root, now, db)?;
        let stages = Stages {
            semantic_graph: stage(
                db,
                "SELECT w.state,COUNT(*) FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE w.state!='replaced' GROUP BY w.state",
            )?,
            episode_vectors: stage(
                db,
                "SELECT u.state,COUNT(*) FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE u.record_kind='episode' AND u.state!='superseded' GROUP BY u.state",
            )?,
            node_vectors: stage(
                db,
                "SELECT u.state,COUNT(*) FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE u.record_kind='node' AND u.state!='superseded' GROUP BY u.state",
            )?,
            hot_cache: stage(
                db,
                "SELECT COALESCE(json_extract(j.hot_cache_state,'$.state'),'failed'),COUNT(*) FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision GROUP BY 1",
            )?,
        };
        let oldest = db.query_row("SELECT MIN(created_at), MIN(CASE WHEN is_vector=1 THEN created_at END) FROM (SELECT j.created_at, 0 AS is_vector FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE w.state IN ('pending','planned','running','failed') UNION ALL SELECT j.created_at, 1 AS is_vector FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE u.state IN ('pending','running','failed') UNION ALL SELECT j.created_at, 0 AS is_vector FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE COALESCE(json_extract(j.hot_cache_state,'$.state'),'pending') NOT IN ('complete','not_configured'))",[],|row|Ok((row.get::<_,Option<String>>(0)?,row.get::<_,Option<String>>(1)?)))?;
        Ok(Self {
            registered,
            current,
            inventory,
            stages,
            oldest_vector: oldest.1,
            oldest_age: oldest
                .0
                .as_deref()
                .and_then(butler_core::js_date::parse_iso_millis)
                .map(|at| now.saturating_sub(at).max(0)),
            failures: count(
                db,
                "SELECT COUNT(*) FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE w.state='failed' AND w.error_code LIKE 'memory_source_%'",
            )?,
            historical_failures: count(
                db,
                "SELECT COUNT(*) FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE j.revision<>c.current_revision AND w.state='failed' AND w.error_code LIKE 'memory_source_%'",
            )?,
            mismatch: count(
                db,
                "SELECT COUNT(*) FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE u.error_code='memory_embedding_version_mismatch'",
            )?,
            historical_mismatch: count(
                db,
                "SELECT COUNT(*) FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE j.revision<>c.current_revision AND u.error_code='memory_embedding_version_mismatch'",
            )?,
            pending_quality: pending_quality(data_root, generation_id, db)?,
        })
    }

    fn into_health(
        self,
        generation_id: String,
        revision: i64,
        cache: crate::cognition::generation::HotCacheHealth,
        profile: Option<&ProfileCoverageHealth>,
    ) -> ServingHealth {
        ServingHealth {
            available: true,
            reason: None,
            generation_id: Some(generation_id),
            graph_revision: Some(revision),
            sources: ServingSources {
                unit: "scalar_source",
                eligible: None,
                known_eligible: self.inventory.0,
                registered: Some(self.registered),
                registered_current: Some(self.current),
                unknown_origin_excluded: None,
                inventory_complete: false,
                inventory_reason: self.inventory.2,
                coverage_percent: None,
                known_coverage_percent: self.inventory.1,
                coverage_reason: "inventory_incomplete",
            },
            memories_without_vectors: Some(
                self.stages.node_vectors.pending
                    + self.stages.node_vectors.failed
                    + self.stages.episode_vectors.pending
                    + self.stages.episode_vectors.failed,
            ),
            oldest_vector_pending_at: self.oldest_vector,
            stages: self.stages,
            stage_units: STAGE_UNITS,
            oldest_pending_age_ms: self.oldest_age,
            source_resolution_failures: Some(self.failures),
            historical_source_resolution_failures: Some(self.historical_failures),
            embedding_version_mismatch: Some(self.mismatch),
            historical_embedding_version_mismatch: Some(self.historical_mismatch),
            pending_quality_operations: Some(self.pending_quality),
            cache,
            profile: profile.cloned(),
        }
    }
}

fn graph_revision(db: &Connection) -> rusqlite::Result<Option<i64>> {
    db.query_row(
        "SELECT value FROM memory_state WHERE key='graph_revision'",
        [],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map(|value| value.and_then(|raw| raw.parse().ok()))
}

fn count(db: &Connection, sql: &str) -> rusqlite::Result<i64> {
    db.query_row(sql, [], |row| row.get(0))
}

/// Work items by state; any state other than complete, failed and
/// not_configured is pending.
fn stage(db: &Connection, sql: &str) -> rusqlite::Result<StageCount> {
    let mut counts = StageCount::default();
    let mut statement = db.prepare(sql)?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    for row in rows {
        let (state, count) = row?;
        let slot = match state.as_str() {
            "complete" => &mut counts.complete,
            "failed" => &mut counts.failed,
            "not_configured" => &mut counts.not_configured,
            _ => &mut counts.pending,
        };
        *slot += count;
    }
    Ok(counts)
}

fn inventory(
    data_root: &Path,
    now: i64,
    db: &Connection,
) -> rusqlite::Result<(usize, Option<f64>, &'static str)> {
    let path = conversation_store_path(data_root);
    let Ok(reader) = ConversationSourceReader::open(&path) else {
        return Ok((0, None, "canonical_inventory_unavailable"));
    };
    let request = RecallRequest {
        cue: String::new(),
        seed_phrases: vec![],
        vector_queries: vec![],
        include_vector: false,
        include_internal: false,
        limit: 1,
        scope: RecallScope::AllUserSessions,
        project_filter: RecallProjectFilter::Any,
        project_ids: vec![],
        session_ids: vec![],
        as_of: chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now)
            .map(|value| value.to_rfc3339())
            .unwrap_or_default(),
        as_of_explicit: false,
        time: None,
        cursor: None,
        admitted_channels: None,
        runtime: RecallRuntime {
            session_id: String::new(),
            turn_id: "memory-health".into(),
            current_user_message: String::new(),
            native_operation_id: "memory-health".into(),
            project_id: None,
        },
    };
    let result = read_canonical_inventory(
        Some(&reader),
        &request,
        chrono::Utc::now().timestamp_millis().saturating_add(1_000),
        &|text| butler_core::js_date::parse_iso_millis(text).map_or(f64::NAN, |ms| ms as f64),
        &|left, right| left.cmp(right),
        || chrono::Utc::now().timestamp_millis(),
    );
    let closed = reader.close();
    let inventory = result.map_err(|_| rusqlite::Error::InvalidQuery)?;
    closed.map_err(|_| rusqlite::Error::InvalidQuery)?;
    let known = inventory
        .entries
        .iter()
        .map(|entry| entry.source_unit_count)
        .sum::<usize>();
    let complete = inventory.entries.iter().try_fold(0_usize, |sum, entry| {
        let found = db.query_row("SELECT 1 FROM memory_chunks c JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision WHERE c.memory_chunk_id=?1 AND c.current_revision=?2 AND json_extract(j.semantic_graph_state,'$.state')='complete' LIMIT 1",params![entry.episode_id,entry.revision],|row|row.get::<_,i64>(0)).optional()?.is_some();
        Ok::<usize, rusqlite::Error>(sum + if found { entry.source_unit_count } else { 0 })
    })?;
    Ok((
        known,
        (known > 0).then_some((complete as f64 / known as f64 * 10_000.0).round() / 100.0),
        if !inventory.available {
            "canonical_inventory_unavailable"
        } else if inventory.partial {
            "canonical_inventory_partial"
        } else {
            "typed_inventory_unavailable"
        },
    ))
}

fn pending_quality(data_root: &Path, generation: &str, db: &Connection) -> rusqlite::Result<usize> {
    let Ok(file) = File::open(data_root.join("cognition/feedback/quality-operations.jsonl")) else {
        return Ok(0);
    };
    let mut statement = db.prepare("SELECT s.source_id,s.episode_id,s.revision,s.content_hash FROM memory_chunk_sources s JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision WHERE c.status='active'")?;
    let sources = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let rows = sources
        .iter()
        .map(
            |(source_id, episode_id, revision, content_hash)| FeedbackSourceRow {
                source_id,
                episode_id,
                revision,
                content_hash,
            },
        )
        .collect::<Vec<_>>();
    let excluded = excluded_source_ids(&data_root.join("cognition/feedback"), &rows, |operation| {
        db.query_row(
            "SELECT value FROM memory_state WHERE key=?1",
            [format!("quality_operation:{operation}")],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|source| {
            crate::cognition::CognitionError::new(
                CognitionCode::MemoryHealthReadFailed,
                "Feedback receipt unavailable",
            )
            .with_source(source)
        })
    })
    // The rusqlite error type cannot carry a Cognition error; the probe only
    // needs to know the receipt lookup failed.
    .map_err(|_receipt_error| rusqlite::Error::InvalidQuery)?;
    let mut count = 0;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let operation: QualityOperation = crate::lenient::view(&value);
        if operation.status.as_deref() != Some("pending")
            || operation.generation_id.as_deref() != Some(generation)
        {
            continue;
        }
        if operation
            .source_ref
            .is_some_and(|source| excluded.contains(&source))
        {
            count += 1;
        }
    }
    Ok(count)
}

/// A line of `cognition/feedback/quality-operations.jsonl`.
#[derive(Default, Deserialize)]
struct QualityOperation {
    #[serde(default, deserialize_with = "crate::lenient::option")]
    status: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    generation_id: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    source_ref: Option<String>,
}

/// The serving facts when the graph cannot be read: zero stage counts and
/// unknown source totals, with the cache read on its own.
fn unavailable(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    now: i64,
    reason: &'static str,
    profile: Option<&ProfileCoverageHealth>,
) -> ServingHealth {
    let cache = resolve_active_generation(data_root, paths).map_or_else(
        |_| crate::cognition::generation::HotCacheHealth::unavailable("generation_unavailable", 0),
        |handle| {
            let revision =
                Connection::open_with_flags(&handle.graph_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .ok()
                    .and_then(|db| graph_revision(&db).ok().flatten())
                    .unwrap_or(-1);
            crate::cognition::generation::read_hot_cache_health(data_root, &handle, now, revision)
        },
    );
    ServingHealth {
        available: false,
        reason: Some(reason),
        generation_id: None,
        graph_revision: None,
        sources: ServingSources {
            unit: "scalar_source",
            eligible: None,
            known_eligible: 0,
            registered: None,
            registered_current: None,
            unknown_origin_excluded: None,
            inventory_complete: false,
            inventory_reason: "canonical_inventory_unavailable",
            coverage_percent: None,
            known_coverage_percent: None,
            coverage_reason: "inventory_incomplete",
        },
        stages: Stages::default(),
        stage_units: STAGE_UNITS,
        oldest_pending_age_ms: None,
        memories_without_vectors: None,
        oldest_vector_pending_at: None,
        source_resolution_failures: None,
        historical_source_resolution_failures: None,
        embedding_version_mismatch: None,
        historical_embedding_version_mismatch: None,
        pending_quality_operations: None,
        cache,
        profile: profile.cloned(),
    }
}
