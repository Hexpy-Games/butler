//! Active-generation serving facts from read-only Cognition and Profile owners.

use std::{
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
};

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Value, json};

use crate::{
    cognition::{
        CognitionPathEnvironment,
        feedback::{FeedbackSourceRow, excluded_source_ids},
        recall::{RecallProjectFilter, RecallRequest, RecallRuntime, RecallScope},
        resolve_active_generation,
        sources::read_canonical_inventory,
    },
    conversation::{ConversationSourceReader, conversation_store_path},
};

pub(super) fn read(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    now: i64,
    profile: &Value,
) -> Value {
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
    let result = (|| -> rusqlite::Result<Value> {
        let registered = count(
            &db,
            "SELECT COUNT(*) FROM memory_chunk_sources WHERE source_id NOT IN (SELECT source_id FROM memory_source_split_parents)",
        )?;
        let current = count(
            &db,
            "SELECT COUNT(*) FROM memory_chunk_sources s JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision WHERE c.status='active' AND NOT EXISTS(SELECT 1 FROM memory_source_split_parents p WHERE p.source_id=s.source_id) AND ((s.source_kind='conversation' AND s.origin_kind IN ('user_input','assistant_public')) OR s.source_kind IN ('task_report','explicit_record'))",
        )?;
        let inventory = inventory(data_root, now, &db)?;
        let stages = json!({
            "semantic_graph":stage(&db,"SELECT w.state,COUNT(*) FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE w.state!='replaced' GROUP BY w.state")?,
            "episode_vectors":stage(&db,"SELECT u.state,COUNT(*) FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE u.record_kind='episode' AND u.state!='superseded' GROUP BY u.state")?,
            "node_vectors":stage(&db,"SELECT u.state,COUNT(*) FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE u.record_kind='node' AND u.state!='superseded' GROUP BY u.state")?,
            "hot_cache":stage(&db,"SELECT COALESCE(json_extract(j.hot_cache_state,'$.state'),'failed'),COUNT(*) FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision GROUP BY 1")?,
        });
        let oldest = db.query_row("SELECT MIN(created_at) FROM (SELECT j.created_at FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE w.state IN ('pending','planned','running','failed') UNION ALL SELECT j.created_at FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE u.state IN ('pending','running','failed') UNION ALL SELECT j.created_at FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE COALESCE(json_extract(j.hot_cache_state,'$.state'),'pending') NOT IN ('complete','not_configured'))",[],|row|row.get::<_,Option<String>>(0))?;
        let old_age = oldest
            .as_deref()
            .and_then(crate::js_date::parse_iso_millis)
            .map(|at| now.saturating_sub(at).max(0));
        let failures = count(
            &db,
            "SELECT COUNT(*) FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE w.state='failed' AND w.error_code LIKE 'memory_source_%'",
        )?;
        let historical_failures = count(
            &db,
            "SELECT COUNT(*) FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE j.revision<>c.current_revision AND w.state='failed' AND w.error_code LIKE 'memory_source_%'",
        )?;
        let mismatch = count(
            &db,
            "SELECT COUNT(*) FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE u.error_code='memory_embedding_version_mismatch'",
        )?;
        let historical_mismatch = count(
            &db,
            "SELECT COUNT(*) FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE j.revision<>c.current_revision AND u.error_code='memory_embedding_version_mismatch'",
        )?;
        let pending_quality = pending_quality(data_root, &handle.generation_id, &db)?;
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
                &profile.clone(),
            ));
        }
        Ok(
            json!({"available":true,"reason":null,"generation_id":handle.generation_id,
            "graph_revision":revision,
            "sources":{"unit":"scalar_source","eligible":null,"known_eligible":inventory.0,
                "registered":registered,"registered_current":current,"unknown_origin_excluded":null,
                "inventory_complete":false,"inventory_reason":inventory.2,
                "coverage_percent":null,"known_coverage_percent":inventory.1,
                "coverage_reason":"inventory_incomplete"},
            "stages":stages,"stage_units":stage_units(),"oldest_pending_age_ms":old_age,
            "source_resolution_failures":failures,"historical_source_resolution_failures":historical_failures,
            "embedding_version_mismatch":mismatch,"historical_embedding_version_mismatch":historical_mismatch,
            "pending_quality_operations":pending_quality,"cache":cache,"profile":profile.clone()}),
        )
    })();
    result.unwrap_or_else(|_| {
        unavailable(data_root, paths, now, "serving_store_unavailable", profile)
    })
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

fn stage(db: &Connection, sql: &str) -> rusqlite::Result<Value> {
    let mut values = [0_i64; 4];
    let mut statement = db.prepare(sql)?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    for row in rows {
        let (state, count) = row?;
        let index = match state.as_str() {
            "complete" => 0,
            "failed" => 2,
            "not_configured" => 3,
            _ => 1,
        };
        values[index] += count;
    }
    Ok(
        json!({"complete":values[0],"pending":values[1],"failed":values[2],"not_configured":values[3]}),
    )
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
        &|text| crate::js_date::parse_iso_millis(text).map_or(f64::NAN, |ms| ms as f64),
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
        .map_err(|_| {
            crate::cognition::CognitionError::new(
                "memory_health_read_failed",
                "Feedback receipt unavailable",
            )
        })
    })
    .map_err(|_| rusqlite::Error::InvalidQuery)?;
    let mut count = 0;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value["status"] != "pending" || value["generation_id"] != generation {
            continue;
        }
        let Some(source) = value["source_ref"].as_str() else {
            continue;
        };
        if excluded.contains(source) {
            count += 1;
        }
    }
    Ok(count)
}

fn stage_units() -> Value {
    json!({"semantic_graph":"window_leaf","episode_vectors":"vector_unit",
        "node_vectors":"vector_unit","hot_cache":"projection_job"})
}

fn unavailable(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    now: i64,
    reason: &str,
    profile: &Value,
) -> Value {
    let empty = json!({"complete":0,"pending":0,"failed":0,"not_configured":0});
    let cache = resolve_active_generation(data_root, paths).map_or_else(
        |_| {
            json!({"available":false,"reason":"generation_unavailable","total_entries":0,
            "current_entries":0,"stale_entries":0,"expired_entries":0,"evicted_entries":0})
        },
        |handle| {
            let revision =
                Connection::open_with_flags(&handle.graph_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .ok()
                    .and_then(|db| graph_revision(&db).ok().flatten())
                    .unwrap_or(-1);
            crate::cognition::generation::read_hot_cache_health(data_root, &handle, now, revision)
        },
    );
    json!({"available":false,"reason":reason,"generation_id":null,"graph_revision":null,
        "sources":{"unit":"scalar_source","eligible":null,"known_eligible":0,
            "registered":null,"registered_current":null,"unknown_origin_excluded":null,
            "inventory_complete":false,"inventory_reason":"canonical_inventory_unavailable",
            "coverage_percent":null,"known_coverage_percent":null,"coverage_reason":"inventory_incomplete"},
        "stages":{"semantic_graph":empty,"episode_vectors":empty,"node_vectors":empty,"hot_cache":empty},
        "stage_units":stage_units(),"oldest_pending_age_ms":null,
        "source_resolution_failures":null,"historical_source_resolution_failures":null,
        "embedding_version_mismatch":null,"historical_embedding_version_mismatch":null,
        "pending_quality_operations":null,
        "cache":cache,
        "profile":profile})
}
