//! Source-revision invalidation of identity decisions: when a new revision
//! supersedes sources an identity merge rested on, the merge is invalidated
//! (restoring the prior redirect when that is still sound) and recorded.

mod history;

use crate::cognition::graph::StageWrite;
use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::db_error;
use crate::cognition::CognitionCode;
use crate::cognition::{CognitionError, CognitionResult, CognitionSourceRow};
use butler_turn::conversation::ConversationSourceReader;
use history::DecisionRecord;

#[derive(Clone, Copy)]
pub(super) struct InvalidationInput<'a> {
    pub old_source_ids: &'a [String],
    pub new_job_id: &'a str,
    pub new_episode_id: &'a str,
    pub new_revision: &'a str,
    pub recorded_at: &'a str,
    pub canonical: &'a ConversationSourceReader,
}

/// Invalidates every identity decision resting on the superseded sources.
/// Returns how many decisions changed.
pub(super) fn superseded_sources(
    connection: &Connection,
    input: InvalidationInput<'_>,
) -> CognitionResult<usize> {
    if input.old_source_ids.is_empty() {
        return Ok(0);
    }
    let placeholders = std::iter::repeat_n("?", input.old_source_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT DISTINCT relation,memory_chunk_id FROM memory_chunk_graph_refs WHERE graph_ref_type='identity_source_job' AND graph_ref_id IN ({placeholders}) ORDER BY relation"
    );
    let mut statement = connection.prepare(&sql).map_err(db_error)?;
    let locators = statement
        .query_map(params_from_iter(input.old_source_ids), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let mut changed = 0;
    for (relation, episode) in locators {
        let Some(old_job) = relation
            .strip_prefix("identity_job:")
            .filter(|id| is_sha(id))
        else {
            continue;
        };
        let owner = connection
            .query_row(
                "SELECT episode_id FROM memory_projection_jobs WHERE job_id=?1",
                [old_job],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)?;
        if owner.as_deref() != Some(&episode) {
            continue;
        }
        for record in history::records_for_job(connection, old_job)? {
            if invalidate(connection, &input, old_job, &record)? {
                changed += 1;
            }
        }
    }
    Ok(changed)
}

/// Invalidates one decision of `old_job` when it quoted a superseded source
/// and is still the node's current decision.
fn invalidate(
    connection: &Connection,
    input: &InvalidationInput<'_>,
    old_job: &str,
    record: &DecisionRecord,
) -> CognitionResult<bool> {
    if !record
        .strings("source_refs")
        .iter()
        .any(|reference| input.old_source_ids.contains(reference))
    {
        return Ok(false);
    }
    let loser = record.string("literal_loser").ok_or_else(|| {
        CognitionError::new(
            CognitionCode::MemoryIdentityHistoryInvalid,
            "memory_identity_history_invalid",
        )
    })?;
    let node = history::node(connection, loser)?;
    if node.history_job.as_deref() != Some(old_job)
        || node.history_ref.as_deref() != record.string("decision_ref")
    {
        return Ok(false);
    }
    let restored = if record.string("operation") == Some("apply")
        && history::valid_preimage(connection, input.canonical, record)?
    {
        record.string("previous_direct_redirect").map(str::to_owned)
    } else {
        None
    };
    let Some(replacement) = first_source(connection, input.new_episode_id, input.new_revision)?
    else {
        return Ok(false);
    };
    let decision_ref = digest(
        format!(
            "{}\0invalidate\0{}\0{}",
            input.new_job_id,
            record.string("decision_ref").unwrap_or(""),
            input.new_revision
        )
        .as_bytes(),
    );
    let invalidation = make_record(
        connection,
        RecordInput {
            record,
            node: &node,
            replacement: &replacement,
            invalidation: input,
            old_job,
            decision_ref: &decision_ref,
            restored: restored.as_deref(),
        },
    )?;
    history::append_record(connection, input.new_job_id, &invalidation)?;
    connection.execute("UPDATE memory_nodes SET canonical_node_id=?1,identity_history_job_id=?2,identity_history_ref=?3 WHERE id=?4",params![restored,input.new_job_id,decision_ref,node.id]).map_err(db_error)?;
    add_locators(
        connection,
        input.new_episode_id,
        input.new_job_id,
        &node.id,
        &invalidation.strings("source_refs"),
    )?;
    mark_derivatives(
        connection,
        &node.id,
        record.string("literal_canonical").unwrap_or(&node.id),
    )?;
    connection
        .execute(
            "UPDATE memory_state SET value=CAST(value AS INTEGER)+1 WHERE key='graph_revision'",
            [],
        )
        .map_err(db_error)?;
    Ok(true)
}

#[derive(Clone, Copy)]
struct RecordInput<'a> {
    record: &'a DecisionRecord,
    node: &'a history::Node,
    replacement: &'a CognitionSourceRow,
    invalidation: &'a InvalidationInput<'a>,
    old_job: &'a str,
    decision_ref: &'a str,
    restored: Option<&'a str>,
}

/// The source a decision rests on, as recorded in a decision.
#[derive(Serialize)]
struct NormalizedSource<'a> {
    source_ref: &'a str,
    episode_id: &'a str,
    revision: &'a str,
    content_hash: &'a str,
    byte_start: f64,
    byte_end: f64,
    quote: &'static str,
    quote_byte_start: f64,
    quote_byte_end: f64,
    project_id: Option<String>,
    session_id: Option<&'a str>,
    origin_kind: &'a str,
    role: &'a str,
    observed_at: &'a str,
}

/// A copy of the invalidated decision that records the invalidation; fields
/// keep their positions and new fields are appended.
fn make_record(connection: &Connection, input: RecordInput<'_>) -> CognitionResult<DecisionRecord> {
    let RecordInput {
        record,
        node,
        replacement,
        invalidation: input,
        old_job,
        decision_ref,
        restored,
    } = input;
    let mut value = record.clone();
    let old_decision = record.string("decision_ref").unwrap_or("");
    let refs = unique_sorted(
        std::iter::once(replacement.source_id.clone()).chain(input.old_source_ids.iter().cloned()),
    );
    let pointer = history::DecisionPointer {
        job_ref: Some(old_job.to_owned()),
        decision_ref: Some(old_decision.to_owned()),
    };
    value.set("decision_ref", decision_ref);
    value.set("operation_id", format!("invalidate:{old_decision}"));
    value.set("payload_digest", digest(input.new_revision.as_bytes()));
    value.set("operation", "invalidate");
    value.set("decision_origin", "source_revision");
    value.set("reason", "source_revision");
    value.set("previous_head", &pointer);
    value.set("previous_direct_redirect", &node.canonical);
    value.set("previous_owner", resolve_current(connection, &node.id)?);
    value.set("resulting_direct_redirect", restored);
    value.set(
        "resulting_owner",
        match restored {
            Some(id) => resolve_current(connection, id)?,
            None => node.id.clone(),
        },
    );
    value.set("source_refs", refs);
    value.set("source_revision", input.new_revision);
    value.set(
        "decision_source",
        normalized_source(connection, replacement)?,
    );
    value.set("loser_source", ());
    value.set("canonical_source", ());
    value.set("target_decision", &pointer);
    value.set("source_observed_at", &replacement.observed_at);
    value.set("recorded_at", input.recorded_at);
    value.set("recorded_outcome", "invalidated");
    Ok(value)
}

pub(super) fn source(
    connection: &Connection,
    id: &str,
) -> CognitionResult<Option<CognitionSourceRow>> {
    connection.query_row("SELECT source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis FROM memory_chunk_sources WHERE source_id=?1 UNION ALL SELECT source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis FROM memory_source_split_parents WHERE source_id=?1 LIMIT 1",[id],source_row).optional().map_err(db_error)
}
fn first_source(
    connection: &Connection,
    episode: &str,
    revision: &str,
) -> CognitionResult<Option<CognitionSourceRow>> {
    connection.query_row("SELECT source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis FROM memory_chunk_sources WHERE episode_id=?1 AND revision=?2 ORDER BY source_id LIMIT 1",params![episode,revision],source_row).optional().map_err(db_error)
}
fn source_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CognitionSourceRow> {
    Ok(CognitionSourceRow {
        source_id: row.get(0)?,
        episode_id: row.get(1)?,
        revision: row.get(2)?,
        source_kind: row.get(3)?,
        conversation_session_id: row.get(4)?,
        conversation_message_id: row.get(5)?,
        part_id: row.get(6)?,
        scalar_pointer: row.get(7)?,
        byte_start: row.get(8)?,
        byte_end: row.get(9)?,
        content_hash: row.get(10)?,
        role: row.get(11)?,
        origin_kind: row.get(12)?,
        observed_at: row.get(13)?,
        basis: row.get(14)?,
    })
}
fn normalized_source<'a>(
    connection: &Connection,
    row: &'a CognitionSourceRow,
) -> CognitionResult<NormalizedSource<'a>> {
    let project_id = connection
        .query_row(
            "SELECT project_id FROM memory_chunks WHERE memory_chunk_id=?1",
            [&row.episode_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| {
            CognitionError::new(
                CognitionCode::MemoryIdentitySourceNotRegistered,
                "memory_identity_source_not_registered",
            )
        })?;
    Ok(NormalizedSource {
        source_ref: &row.source_id,
        episode_id: &row.episode_id,
        revision: &row.revision,
        content_hash: &row.content_hash,
        byte_start: row.byte_start,
        byte_end: row.byte_end,
        quote: "",
        quote_byte_start: row.byte_start,
        quote_byte_end: row.byte_start,
        project_id,
        session_id: row.conversation_session_id.as_deref(),
        origin_kind: &row.origin_kind,
        role: &row.role,
        observed_at: &row.observed_at,
    })
}
fn resolve_current(connection: &Connection, id: &str) -> CognitionResult<String> {
    Ok(redirect_chain(connection, id)?
        .last()
        .cloned()
        .unwrap_or_else(|| id.into()))
}
pub(super) fn redirect_chain(connection: &Connection, id: &str) -> CognitionResult<Vec<String>> {
    let mut output = vec![id.to_owned()];
    for _ in 0..64 {
        let Some(current) = output.last() else { break };
        let next = connection
            .query_row(
                "SELECT canonical_node_id FROM memory_nodes WHERE id=?1",
                [current],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(db_error)?
            .flatten();
        let Some(next) = next else { return Ok(output) };
        if output.contains(&next) {
            return Err(CognitionError::new(
                CognitionCode::MemoryIdentityCycle,
                "memory_identity_cycle",
            ));
        }
        output.push(next);
    }
    Err(CognitionError::new(
        CognitionCode::MemoryIdentityHistoryLimit,
        "memory_identity_history_limit",
    ))
}
fn add_locators(
    connection: &Connection,
    episode: &str,
    job: &str,
    node: &str,
    sources: &[String],
) -> CognitionResult<()> {
    if !is_sha(job) {
        return Err(CognitionError::new(
            CognitionCode::MemoryIdentityJobInvalid,
            "memory_identity_job_invalid",
        ));
    }
    let relation = format!("identity_job:{job}");
    connection.execute("INSERT OR IGNORE INTO memory_chunk_graph_refs VALUES(?1,'identity_endpoint_job',?2,?3)",params![episode,node,relation]).map_err(db_error)?;
    for source in sources {
        connection.execute("INSERT OR IGNORE INTO memory_chunk_graph_refs VALUES(?1,'identity_source_job',?2,?3)",params![episode,source,relation]).map_err(db_error)?;
    }
    Ok(())
}
fn mark_derivatives(connection: &Connection, node: &str, canonical: &str) -> CognitionResult<()> {
    for id in unique_sorted([node.to_owned(), canonical.to_owned()]) {
        connection.execute("UPDATE memory_vector_units SET state='pending',error_code=NULL,next_attempt_at=NULL WHERE record_kind='node' AND owner_id=?1",[id]).map_err(db_error)?;
    }
    let pending = StageWrite::pending().json();
    connection.execute("UPDATE memory_projection_jobs SET hot_cache_state=?1 WHERE job_id IN (SELECT DISTINCT job_id FROM memory_vector_units WHERE owner_id IN (?2,?3))",params![pending,node,canonical]).map_err(db_error)?;
    Ok(())
}
fn digest(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn is_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn unique_sorted(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut values = values
        .into_iter()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    values.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    values
}
