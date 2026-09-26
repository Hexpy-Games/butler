//! Physical candidate cache entry currentness, using the recall quality reader.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::{GraphRepository, db_error, hydrate, source};
use crate::{
    cognition::{
        CognitionResult, CognitionSourceRow, ConversationSourceNotice,
        assert_conversation_source_current,
        feedback::{FeedbackSourceRow, excluded_source_ids},
    },
    conversation::ConversationSourceReader,
};

impl GraphRepository {
    pub(in crate::cognition) fn hot_cache_graph_revision(&self) -> CognitionResult<Option<String>> {
        self.connection()?
            .query_row(
                "SELECT value FROM memory_state WHERE key='graph_revision'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)
    }

    pub(in crate::cognition) fn hot_cache_source_class(
        &self,
        source_refs: &[String],
    ) -> CognitionResult<&'static str> {
        let db = self.connection()?;
        let mut rows = Vec::with_capacity(source_refs.len());
        for source_id in source_refs {
            if let Some(row) = source(db, source_id)? {
                rows.push(row);
            }
        }
        Ok(source_class(&rows))
    }

    pub(in crate::cognition) fn requeue_missing_rebuild_cache(
        &mut self,
        generation: &str,
        jobs: &[String],
    ) -> CognitionResult<usize> {
        let tx = self.connection_mut()?.transaction().map_err(db_error)?;
        let mut changed = 0;
        for job in jobs {
            changed += tx.execute("UPDATE memory_projection_jobs SET hot_cache_state=?1,hot_cache_next_attempt_at=NULL,hot_cache_attempt_count=0 WHERE job_id=?2 AND generation=?3 AND json_extract(hot_cache_state,'$.state')='complete'",
                params![serde_json::json!({"state":"pending","blocked_by":"hot_cache_evidence_missing"}).to_string(),job,generation]).map_err(db_error)?;
        }
        tx.commit().map_err(db_error)?;
        Ok(changed)
    }

    pub(in crate::cognition) fn rebuild_cache_outcomes(
        &self,
        generation: &str,
    ) -> CognitionResult<HashMap<String, bool>> {
        let mut statement = self
            .connection()?
            .prepare("SELECT entry_id,admitted FROM memory_hot_cache_outcomes WHERE generation=?1")
            .map_err(db_error)?;
        statement
            .query_map([generation], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0))
            })
            .map_err(db_error)?
            .collect::<Result<HashMap<_, _>, _>>()
            .map_err(db_error)
    }

    pub(in crate::cognition) fn valid_rebuild_cache_entries(
        &self,
        generation: &str,
        entries: &[Value],
        source_root: &Path,
        canonical: &ConversationSourceReader,
        as_of: &str,
    ) -> CognitionResult<HashSet<String>> {
        let db = self.connection()?;
        let graph_revision = db
            .query_row(
                "SELECT value FROM memory_state WHERE key='graph_revision'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)?
            .and_then(|raw| raw.parse::<i64>().ok())
            .unwrap_or(-1);
        let mut valid = HashSet::new();
        for entry in entries {
            let Some(id) = entry.get("entry_id").and_then(Value::as_str) else {
                continue;
            };
            if entry_current(
                db,
                entry,
                generation,
                source_root,
                canonical,
                as_of,
                graph_revision,
            )? {
                valid.insert(id.to_owned());
            } else {
                valid.remove(id);
            }
        }
        Ok(valid)
    }
}

fn entry_current(
    db: &Connection,
    entry: &Value,
    generation: &str,
    source_root: &Path,
    canonical: &ConversationSourceReader,
    as_of: &str,
    graph_revision: i64,
) -> CognitionResult<bool> {
    let Some(episode) = entry["episode_id"].as_str() else {
        return Ok(false);
    };
    let Some(revision) = entry["source_revision"].as_str() else {
        return Ok(false);
    };
    let Some(refs) = strings(&entry["source_refs"]) else {
        return Ok(false);
    };
    if refs.is_empty() || refs.iter().collect::<HashSet<_>>().len() != refs.len() {
        return Ok(false);
    }
    let Some(stored_revision) = entry["graph_revision"].as_i64() else {
        return Ok(false);
    };
    if stored_revision < 0 || stored_revision > graph_revision {
        return Ok(false);
    }
    if entry["authority"]
        .as_str()
        .is_some_and(|value| value != "model_interpretation")
    {
        return Ok(false);
    }
    if let Some(until) = entry["valid_until"].as_str()
        && let (Some(expiry), Some(now)) = (
            crate::js_date::parse_date_millis(until, &|value| Some(value)),
            crate::js_date::parse_date_millis(as_of, &|value| Some(value)),
        )
        && expiry <= now
    {
        return Ok(false);
    }
    let chunk = db.query_row(
        "SELECT c.current_revision,c.project_id,c.conversation_session_id,c.status,\
                c.source_key,c.source_hash \
         FROM memory_chunks c \
         JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision \
         WHERE c.memory_chunk_id=?1 AND j.generation=?2",
        params![episode, generation],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        },
    )
        .optional().map_err(db_error)?;
    let Some((current, project, session, status, source_key, source_hash)) = chunk else {
        return Ok(false);
    };
    if current != revision
        || status != "active"
        || entry["project_id"].as_str() != project.as_deref()
        || entry["session_id"].as_str() != session.as_deref()
    {
        return Ok(false);
    }
    let mut rows = Vec::with_capacity(refs.len());
    for id in &refs {
        let Some(row) = source(db, id)? else {
            return Ok(false);
        };
        if row.episode_id != episode
            || row.revision != revision
            || !hydrate(canonical, source_root, &row)
        {
            return Ok(false);
        }
        let active = db.query_row("SELECT 1 FROM memory_chunks c JOIN memory_chunk_sources s ON s.episode_id=c.memory_chunk_id AND s.revision=c.current_revision WHERE s.source_id=?1 AND c.memory_chunk_id=?2 AND c.current_revision=?3 AND c.status='active' AND c.project_id IS ?4 AND julianday(s.observed_at)<=julianday(?5)",
            params![row.source_id,row.episode_id,row.revision,project,as_of], |_| Ok(())).optional().map_err(db_error)?.is_some();
        if !active || !source_class_allowed(&row) {
            return Ok(false);
        }
        rows.push(row);
    }
    if rows.iter().any(|row| row.source_kind == "conversation") {
        let Some(window_ref) = entry["window_ref"].as_str() else {
            return Ok(false);
        };
        let extraction_version = db
            .query_row(
                "SELECT j.extraction_version FROM memory_projection_jobs j \
                 JOIN memory_projection_windows w ON w.job_id=j.job_id \
                 WHERE j.episode_id=?1 AND j.revision=?2 AND j.generation=?3 AND w.window_ref=?4",
                params![episode, revision, generation, window_ref],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)?;
        let Some(extraction_version) = extraction_version else {
            return Ok(false);
        };
        if !canonical_conversation_source_current(
            canonical,
            &source_key,
            &source_hash,
            session.as_deref(),
            &extraction_version,
            revision,
            as_of,
        ) {
            return Ok(false);
        }
    }
    if entry["source_class"]
        .as_str()
        .is_some_and(|value| value != source_class(&rows))
    {
        return Ok(false);
    }
    let feedback_rows = rows
        .iter()
        .map(|row| FeedbackSourceRow {
            source_id: &row.source_id,
            episode_id: &row.episode_id,
            revision: &row.revision,
            content_hash: &row.content_hash,
        })
        .collect::<Vec<_>>();
    let excluded = excluded_source_ids(
        &source_root.join("cognition/feedback"),
        &feedback_rows,
        |operation| {
            db.query_row(
                "SELECT value FROM memory_state WHERE key=?1",
                [format!("quality_operation:{operation}")],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)
        },
    )?;
    if refs.iter().any(|id| excluded.contains(id)) {
        return Ok(false);
    }
    if superseded(db, entry, &rows, as_of, source_root, canonical)? {
        return Ok(false);
    }
    Ok(true)
}

fn source_class_allowed(row: &CognitionSourceRow) -> bool {
    match row.source_kind.as_str() {
        "conversation" => matches!(row.origin_kind.as_str(), "user_input" | "assistant_public"),
        "task_report" => row.role == "task" && row.basis == "reviewed_task",
        "explicit_record" => row.role == "explicit" && row.basis == "user_statement",
        _ => false,
    }
}

fn source_class(rows: &[CognitionSourceRow]) -> &'static str {
    let classify = |row: &CognitionSourceRow| match row.source_kind.as_str() {
        "task_report" => "task_report",
        "explicit_record" => "explicit",
        _ if row.role == "user" && row.origin_kind == "user_input" => "user",
        _ if row.role == "assistant" && row.origin_kind == "assistant_public" => "assistant",
        _ => "unknown",
    };
    let Some(first) = rows.first().map(classify) else {
        return "unknown";
    };
    if rows.iter().all(|row| classify(row) == first) {
        first
    } else {
        "mixed"
    }
}

fn canonical_conversation_source_current(
    canonical: &ConversationSourceReader,
    source_key: &str,
    source_hash: &str,
    session_id: Option<&str>,
    extraction_version: &str,
    revision: &str,
    as_of: &str,
) -> bool {
    let Some(session_id) = session_id else {
        return false;
    };
    let notice = if let Some(turn_id) = source_key.strip_prefix("conversation_turn:") {
        let Ok(Some(outcome)) = canonical.read_turn_outcome(turn_id) else {
            return false;
        };
        ConversationSourceNotice::Turn {
            session_id,
            turn_id,
            outcome_generation: outcome.generation,
            extraction_version,
        }
    } else if let Some(message_id) = source_key.strip_prefix("conversation_message:") {
        ConversationSourceNotice::Standalone {
            session_id,
            message_id,
            source_hash,
            extraction_version,
        }
    } else {
        return false;
    };
    assert_conversation_source_current(canonical, notice, revision, as_of).is_ok()
}

fn superseded(
    db: &Connection,
    entry: &Value,
    rows: &[CognitionSourceRow],
    as_of: &str,
    source_root: &Path,
    canonical: &ConversationSourceReader,
) -> CognitionResult<bool> {
    let Some(nodes) = strings(&entry["node_refs"]) else {
        return Ok(false);
    };
    let episode = entry["episode_id"].as_str().unwrap_or("");
    let mut corrections = Vec::new();
    for node in nodes {
        for row in rows {
            let mut statement=db.prepare("SELECT ee.chunk_source_id FROM memory_evidence candidate JOIN edges e ON e.target_node_id=candidate.node_id AND e.rel_type='supersedes' AND e.status='active' JOIN edge_evidence ee ON ee.edge_id=e.edge_id JOIN memory_chunk_sources correction ON correction.source_id=ee.chunk_source_id JOIN memory_chunks c ON c.memory_chunk_id=correction.episode_id AND c.current_revision=correction.revision WHERE candidate.episode_id=?1 AND candidate.node_id=?2 AND candidate.source_id=?3 AND (e.valid_from IS NULL OR julianday(e.valid_from)<=julianday(?4)) AND (e.valid_to IS NULL OR julianday(e.valid_to)>julianday(?4)) AND c.status='active' AND c.project_id IS ?5 AND julianday(correction.observed_at)<=julianday(?4)").map_err(db_error)?;
            let evidence = statement
                .query_map(
                    params![
                        episode,
                        node,
                        row.source_id,
                        as_of,
                        entry["project_id"].as_str()
                    ],
                    |row| row.get::<_, String>(0),
                )
                .map_err(db_error)?;
            for id in evidence {
                let id = id.map_err(db_error)?;
                let Some(source) = source(db, &id)? else {
                    continue;
                };
                if !source_class_allowed(&source) || !hydrate(canonical, source_root, &source) {
                    continue;
                }
                corrections.push(source);
            }
        }
    }
    if corrections.is_empty() {
        return Ok(false);
    }
    let feedback_rows = corrections
        .iter()
        .map(|row| FeedbackSourceRow {
            source_id: &row.source_id,
            episode_id: &row.episode_id,
            revision: &row.revision,
            content_hash: &row.content_hash,
        })
        .collect::<Vec<_>>();
    let excluded = excluded_source_ids(
        &source_root.join("cognition/feedback"),
        &feedback_rows,
        |operation| {
            db.query_row(
                "SELECT value FROM memory_state WHERE key=?1",
                [format!("quality_operation:{operation}")],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)
        },
    )?;
    Ok(corrections
        .iter()
        .any(|row| !excluded.contains(&row.source_id)))
}

fn strings(value: &Value) -> Option<Vec<String>> {
    value
        .as_array()?
        .iter()
        .map(|item| item.as_str().map(str::to_owned))
        .collect()
}
