//! Physical candidate cache entry currentness, using the recall quality reader.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use crate::cognition::generation::HotCacheEntryView;
use rusqlite::{Connection, OptionalExtension, params};

use super::{GraphRepository, db_error, hydrate, source};
use crate::cognition::feedback::{FeedbackSourceRow, excluded_source_ids};
use crate::cognition::{
    CognitionResult, CognitionSourceRow, ConversationSourceNotice,
    assert_conversation_source_current,
};
use butler_turn::conversation::ConversationSourceReader;

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
                params![crate::cognition::graph::StageWrite::blocked("hot_cache_evidence_missing").json(),job,generation]).map_err(db_error)?;
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

    /// The ids of `entries` whose evidence is still current as of `as_of`.
    pub(in crate::cognition) fn valid_rebuild_cache_entries(
        &self,
        generation: &str,
        entries: &[HotCacheEntryView],
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
        let check = EntryCheck {
            db,
            generation,
            source_root,
            canonical,
            as_of,
            graph_revision,
        };
        let mut valid = HashSet::new();
        for entry in entries {
            let Some(id) = entry.entry_id.as_deref() else {
                continue;
            };
            if check.current(entry)? {
                valid.insert(id.to_owned());
            } else {
                valid.remove(id);
            }
        }
        Ok(valid)
    }
}

/// The graph, sources, and time a cache entry is validated against.
struct EntryCheck<'a> {
    db: &'a Connection,
    generation: &'a str,
    source_root: &'a Path,
    canonical: &'a ConversationSourceReader,
    as_of: &'a str,
    graph_revision: i64,
}

/// The current chunk of an entry's episode in this generation.
struct EntryChunk {
    revision: String,
    project: Option<String>,
    session: Option<String>,
    status: String,
    source_key: String,
    source_hash: String,
}

impl EntryCheck<'_> {
    /// An entry is current when its metadata is well formed, its episode and
    /// sources are current and eligible, no quality operation excludes a
    /// source, and no later correction supersedes it.
    fn current(&self, entry: &HotCacheEntryView) -> CognitionResult<bool> {
        let (Some(episode), Some(revision), Some(refs)) = (
            entry.episode_id.as_deref(),
            entry.source_revision.as_deref(),
            entry.source_refs.as_deref(),
        ) else {
            return Ok(false);
        };
        if !self.metadata_valid(entry, refs) {
            return Ok(false);
        }
        let Some(chunk) = self.chunk(episode)? else {
            return Ok(false);
        };
        if chunk.revision != revision
            || chunk.status != "active"
            || entry.project_id.as_deref() != chunk.project.as_deref()
            || entry.session_id.as_deref() != chunk.session.as_deref()
        {
            return Ok(false);
        }
        let Some(rows) = self.source_rows(refs, (episode, revision), chunk.project.as_deref())?
        else {
            return Ok(false);
        };
        if rows.iter().any(|row| row.source_kind == "conversation")
            && !self.conversation_current(entry, (episode, revision), &chunk)?
        {
            return Ok(false);
        }
        if entry
            .source_class
            .as_deref()
            .is_some_and(|value| value != source_class(&rows))
        {
            return Ok(false);
        }
        let excluded = excluded(self.db, self.source_root, &rows)?;
        if refs.iter().any(|id| excluded.contains(id)) {
            return Ok(false);
        }
        Ok(!superseded(
            self.db,
            entry,
            &rows,
            self.as_of,
            self.source_root,
            self.canonical,
        )?)
    }

    /// Distinct refs, a graph revision the graph has reached, model
    /// authority, and no expiry by `as_of`.
    fn metadata_valid(&self, entry: &HotCacheEntryView, refs: &[String]) -> bool {
        if refs.is_empty() || refs.iter().collect::<HashSet<_>>().len() != refs.len() {
            return false;
        }
        if !entry
            .graph_revision
            .is_some_and(|stored| stored >= 0 && stored <= self.graph_revision)
        {
            return false;
        }
        if entry
            .authority
            .as_deref()
            .is_some_and(|value| value != "model_interpretation")
        {
            return false;
        }
        let expired = entry.valid_until.as_deref().is_some_and(|until| {
            let millis = |value| butler_core::js_date::parse_date_millis(value, &|local| Some(local));
            matches!((millis(until), millis(self.as_of)), (Some(expiry), Some(now)) if expiry <= now)
        });
        !expired
    }

    fn chunk(&self, episode: &str) -> CognitionResult<Option<EntryChunk>> {
        self.db
            .query_row(
                "SELECT c.current_revision,c.project_id,c.conversation_session_id,c.status,\
                        c.source_key,c.source_hash \
                 FROM memory_chunks c \
                 JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision \
                 WHERE c.memory_chunk_id=?1 AND j.generation=?2",
                params![episode, self.generation],
                |row| {
                    Ok(EntryChunk {
                        revision: row.get(0)?,
                        project: row.get(1)?,
                        session: row.get(2)?,
                        status: row.get(3)?,
                        source_key: row.get(4)?,
                        source_hash: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(db_error)
    }

    /// Every ref's source row, when each belongs to the entry's revision, is
    /// readable, active by `as_of`, and of an eligible class.
    fn source_rows(
        &self,
        refs: &[String],
        (episode, revision): (&str, &str),
        project: Option<&str>,
    ) -> CognitionResult<Option<Vec<CognitionSourceRow>>> {
        let mut rows = Vec::with_capacity(refs.len());
        for id in refs {
            let Some(row) = source(self.db, id)? else {
                return Ok(None);
            };
            if row.episode_id != episode
                || row.revision != revision
                || !hydrate(self.canonical, self.source_root, &row)
            {
                return Ok(None);
            }
            let active = self.db.query_row("SELECT 1 FROM memory_chunks c JOIN memory_chunk_sources s ON s.episode_id=c.memory_chunk_id AND s.revision=c.current_revision WHERE s.source_id=?1 AND c.memory_chunk_id=?2 AND c.current_revision=?3 AND c.status='active' AND c.project_id IS ?4 AND julianday(s.observed_at)<=julianday(?5)",
                params![row.source_id,row.episode_id,row.revision,project,self.as_of], |_| Ok(())).optional().map_err(db_error)?.is_some();
            if !active || !source_class_allowed(&row) {
                return Ok(None);
            }
            rows.push(row);
        }
        Ok(Some(rows))
    }

    /// A conversation entry's window must exist in this generation and its
    /// canonical source must still be current.
    fn conversation_current(
        &self,
        entry: &HotCacheEntryView,
        (episode, revision): (&str, &str),
        chunk: &EntryChunk,
    ) -> CognitionResult<bool> {
        let Some(window_ref) = entry.window_ref.as_deref() else {
            return Ok(false);
        };
        let extraction_version = self
            .db
            .query_row(
                "SELECT j.extraction_version FROM memory_projection_jobs j \
                 JOIN memory_projection_windows w ON w.job_id=j.job_id \
                 WHERE j.episode_id=?1 AND j.revision=?2 AND j.generation=?3 AND w.window_ref=?4",
                params![episode, revision, self.generation, window_ref],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)?;
        let Some(extraction_version) = extraction_version else {
            return Ok(false);
        };
        Ok(canonical_conversation_source_current(
            self.canonical,
            &chunk.source_key,
            &chunk.source_hash,
            chunk.session.as_deref(),
            &extraction_version,
            revision,
            self.as_of,
        ))
    }
}

/// Source ids of `rows` a recorded quality operation excludes.
fn excluded(
    db: &Connection,
    source_root: &Path,
    rows: &[CognitionSourceRow],
) -> CognitionResult<HashSet<String>> {
    let feedback_rows = rows
        .iter()
        .map(|row| FeedbackSourceRow {
            source_id: &row.source_id,
            episode_id: &row.episode_id,
            revision: &row.revision,
            content_hash: &row.content_hash,
        })
        .collect::<Vec<_>>();
    excluded_source_ids(
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
    )
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
    entry: &HotCacheEntryView,
    rows: &[CognitionSourceRow],
    as_of: &str,
    source_root: &Path,
    canonical: &ConversationSourceReader,
) -> CognitionResult<bool> {
    let Some(nodes) = &entry.node_refs else {
        return Ok(false);
    };
    let episode = entry.episode_id.as_deref().unwrap_or("");
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
                        entry.project_id.as_deref()
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
    let excluded = excluded(db, source_root, &corrections)?;
    Ok(corrections
        .iter()
        .any(|row| !excluded.contains(&row.source_id)))
}
