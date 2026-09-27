//! Source-revision invalidation of identity decisions: when a new revision
//! supersedes sources an identity merge rested on, the merge is invalidated
//! (restoring the prior redirect when that is still sound) and recorded.

mod history;

use crate::cognition::graph::StageWrite;
use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use sha2::{Digest, Sha256};

use super::db_error;
use crate::cognition::CognitionCode;
use crate::cognition::graph::identity_decision::DecisionOperation;
use crate::cognition::{CognitionError, CognitionResult, CognitionSourceRow};
use crate::lenient::{Arg, Obj};
use butler_turn::conversation::ConversationSourceReader;
use history::{
    DecisionOrigin, DecisionPointer, DecisionReason, DecisionRecord, DecisionSource,
    RecordedOutcome,
};

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
        .source_refs
        .iter()
        .any(|reference| input.old_source_ids.contains(reference))
    {
        return Ok(false);
    }
    let loser = record.literal_loser.valid().ok_or_else(|| {
        CognitionError::new(
            CognitionCode::MemoryIdentityHistoryInvalid,
            "memory_identity_history_invalid",
        )
    })?;
    let node = history::node(connection, loser)?;
    if node.history_job.as_deref() != Some(old_job) || node.history_ref != record.decision_ref {
        return Ok(false);
    }
    let restored = if record.operation == Some(DecisionOperation::Apply)
        && history::valid_preimage(connection, input.canonical, record)?
    {
        record.previous_direct_redirect.clone()
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
            record.decision_ref.as_deref().unwrap_or(""),
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
        &invalidation.source_refs,
    )?;
    mark_derivatives(
        connection,
        &node.id,
        record.literal_canonical.valid().unwrap_or(&node.id),
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

/// A copy of the invalidated decision that records the invalidation: the
/// fields it owns are overwritten, every other field is kept as stored.
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
    let old_decision = record.decision_ref.clone().unwrap_or_default();
    let pointer = DecisionPointer {
        job_ref: Some(old_job.to_owned()),
        decision_ref: Some(old_decision.clone()),
    };
    let previous_owner = resolve_current(connection, &node.id)?;
    let resulting_owner = match restored {
        Some(id) => resolve_current(connection, id)?,
        None => node.id.clone(),
    };
    Ok(DecisionRecord {
        decision_ref: Some(decision_ref.to_owned()),
        operation_id: Some(format!("invalidate:{old_decision}")),
        payload_digest: Some(digest(input.new_revision.as_bytes())),
        operation: Some(DecisionOperation::Invalidate),
        decision_origin: Some(DecisionOrigin::SourceRevision),
        reason: Some(DecisionReason::SourceRevision),
        previous_head: Some(pointer.clone()),
        previous_direct_redirect: node.canonical.clone(),
        previous_owner: Some(previous_owner),
        resulting_direct_redirect: restored.map(str::to_owned),
        resulting_owner: Some(resulting_owner),
        source_refs: unique_sorted(
            std::iter::once(replacement.source_id.clone())
                .chain(input.old_source_ids.iter().cloned()),
        ),
        decision_source: Arg::Valid(Obj(normalized_source(connection, replacement)?)),
        loser_source: Arg::Null,
        canonical_source: Arg::Null,
        target_decision: Some(pointer),
        source_revision: Some(input.new_revision.to_owned()),
        source_observed_at: Some(replacement.observed_at.clone()),
        recorded_at: Some(input.recorded_at.to_owned()),
        recorded_outcome: Some(RecordedOutcome::Invalidated),
        ..record.clone()
    })
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
/// The source a decision rests on, as a decision records it.
fn normalized_source(
    connection: &Connection,
    row: &CognitionSourceRow,
) -> CognitionResult<DecisionSource> {
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
    Ok(DecisionSource {
        source_ref: Some(row.source_id.clone()),
        episode_id: Some(row.episode_id.clone()),
        revision: Some(row.revision.clone()),
        content_hash: Some(row.content_hash.clone()),
        byte_start: Some(row.byte_start),
        byte_end: Some(row.byte_end),
        quote: Some(String::new()),
        quote_byte_start: Some(row.byte_start),
        quote_byte_end: Some(row.byte_start),
        project_id,
        session_id: row.conversation_session_id.clone(),
        origin_kind: Some(row.origin_kind.clone()),
        role: Some(row.role.clone()),
        observed_at: Some(row.observed_at.clone()),
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
    let pending = StageWrite::pending().json()?;
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
