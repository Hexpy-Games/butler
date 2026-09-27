//! Identity decision history of a projection job: the records stored in
//! `identity_decisions_json`, and the preimage checks an invalidation needs.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, value::RawValue};

use super::{db_error, redirect_chain, source};
use crate::cognition::CognitionCode;
use crate::cognition::graph::identity_decision::DecisionOperation;
use crate::cognition::{CognitionError, CognitionResult, hydrate_conversation_source};
use crate::lenient::{self, Arg, Obj};
use butler_turn::conversation::ConversationSourceReader;

/// One identity decision (`butler.memory-identity-decision.v1`) as stored in
/// `identity_decisions_json`.
///
/// Fields are declared in the order the decision writer stored them, so an
/// invalidation that copies a decision keeps its key order. The fields an
/// invalidation copies without reading (`Arg`) keep a missing key, an
/// explicit `null` or a value of another type exactly as stored.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(super) struct DecisionRecord {
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub schema: Arg<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub decision_ref: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub operation_id: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub payload_digest: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub operation: Option<DecisionOperation>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub decision_origin: Option<DecisionOrigin>,
    /// The node the decision redirected.
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub literal_loser: Arg<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub reason: Option<DecisionReason>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub review_note: Arg<String>,
    /// The node an apply redirected the loser to.
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub literal_canonical: Arg<String>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub resolved_target: Arg<String>,
    /// The loser's decision before this one.
    #[serde(default, deserialize_with = "lenient::option")]
    pub previous_head: Option<DecisionPointer>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub previous_direct_redirect: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub previous_owner: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub resulting_direct_redirect: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub resulting_owner: Option<String>,
    /// The sources the decision rests on.
    #[serde(default, deserialize_with = "lenient::string_list")]
    pub source_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub node_type: Arg<String>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub identity_scope: Arg<String>,
    #[serde(default, skip_serializing_if = "Arg::is_missing")]
    pub project_id: Arg<String>,
    #[serde(default)]
    pub decision_source: Arg<Obj<DecisionSource>>,
    #[serde(default)]
    pub loser_source: Arg<Obj<DecisionSource>>,
    #[serde(default)]
    pub canonical_source: Arg<Obj<DecisionSource>>,
    /// The decision a revoke or invalidation undid.
    #[serde(default, deserialize_with = "lenient::option")]
    pub target_decision: Option<DecisionPointer>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub source_revision: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub source_observed_at: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub recorded_at: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub recorded_outcome: Option<RecordedOutcome>,
    /// Passthrough: keys no decision writer here knows, kept after the known
    /// fields when a decision is copied.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Who made a decision.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum DecisionOrigin {
    /// An operator command.
    OperatorCli,
    /// A new source revision.
    SourceRevision,
}

/// Why a decision was made.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum DecisionReason {
    /// The user named an alias.
    ExplicitAlias,
    /// The user corrected an identity.
    ExplicitIdentityCorrection,
    /// An operator reviewed a duplicate.
    ReviewedDuplicate,
    /// An operator revoked an apply.
    OperatorRevoke,
    /// A new revision superseded the decision's sources.
    SourceRevision,
}

/// What a decision left behind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum RecordedOutcome {
    /// The redirect was applied.
    Applied,
    /// A revoke restored the redirect before the apply.
    RestoredPrevious,
    /// A revoke left the node independent.
    RestoredIndependent,
    /// A source revision invalidated the decision.
    Invalidated,
}

/// A `{job_ref, decision_ref}` pointer to another decision.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct DecisionPointer {
    #[serde(default, deserialize_with = "lenient::option")]
    pub job_ref: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub decision_ref: Option<String>,
}

/// A source a decision quoted, fields in the stored order.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(super) struct DecisionSource {
    #[serde(default, deserialize_with = "lenient::option")]
    pub source_ref: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub episode_id: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub revision: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub content_hash: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub byte_start: Option<f64>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub byte_end: Option<f64>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub quote: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub quote_byte_start: Option<f64>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub quote_byte_end: Option<f64>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub project_id: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub session_id: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub origin_kind: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub role: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub observed_at: Option<String>,
}

impl DecisionRecord {
    /// The decision's recorded sources; a binding of another shape reads as
    /// one that can never be current.
    fn source_bindings(&self) -> Vec<Option<&DecisionSource>> {
        [
            &self.decision_source,
            &self.loser_source,
            &self.canonical_source,
        ]
        .into_iter()
        .filter_map(|binding| match binding {
            Arg::Missing | Arg::Null => None,
            Arg::Valid(Obj(source)) => Some(Some(source)),
            Arg::Invalid(_) => Some(None),
        })
        .collect()
    }
}

pub(super) struct Node {
    pub id: String,
    pub canonical: Option<String>,
    pub history_job: Option<String>,
    pub history_ref: Option<String>,
}

pub(super) fn node(connection: &Connection, id: &str) -> CognitionResult<Node> {
    connection
        .query_row(
            "SELECT id,canonical_node_id,identity_history_job_id,identity_history_ref FROM memory_nodes WHERE id=?1",
            [id],
            |row| {
                Ok(Node {
                    id: row.get(0)?,
                    canonical: row.get(1)?,
                    history_job: row.get(2)?,
                    history_ref: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| CognitionError::new(CognitionCode::MemoryIdentityNodeMissing, "memory_identity_node_missing"))
}

/// Whether an applied redirect can be restored: the apply that set it must
/// still rest on current sources and restoring it must not form a cycle.
pub(super) fn valid_preimage(
    connection: &Connection,
    canonical: &ConversationSourceReader,
    record: &DecisionRecord,
) -> CognitionResult<bool> {
    let (Some(previous), Some(head)) = (
        record.previous_direct_redirect.as_deref(),
        record.previous_head.clone(),
    ) else {
        return Ok(false);
    };
    let Some(owner) = find_owning_apply(connection, head, previous)? else {
        return Ok(false);
    };
    if !record_sources_current(connection, canonical, &owner)? {
        return Ok(false);
    }
    Ok(!redirect_chain(connection, previous)
        .unwrap_or_default()
        .iter()
        .any(|id| Some(id) == record.literal_loser.valid()))
}

/// Follows `previous_head` pointers (through revokes and invalidations of
/// the same redirect) to the apply that set `direct`.
fn find_owning_apply(
    connection: &Connection,
    initial: DecisionPointer,
    direct: &str,
) -> CognitionResult<Option<DecisionRecord>> {
    let mut head = Some(initial);
    let mut visited = HashSet::new();
    while let Some(pointer) = head.take() {
        if visited.len() >= 64 {
            return Ok(None);
        }
        let (Some(job), Some(reference)) = (pointer.job_ref, pointer.decision_ref) else {
            return Ok(None);
        };
        if !visited.insert(format!("{job}\0{reference}")) {
            return Ok(None);
        }
        let Some(record) = find_record(connection, &job, &reference)? else {
            return Ok(None);
        };
        if record.operation == Some(DecisionOperation::Apply)
            && record.resulting_direct_redirect.as_deref() == Some(direct)
        {
            return Ok(Some(record));
        }
        head = next_head(connection, &record, direct)?;
    }
    Ok(None)
}

fn find_record(
    connection: &Connection,
    job: &str,
    reference: &str,
) -> CognitionResult<Option<DecisionRecord>> {
    Ok(records_for_job(connection, job)?
        .into_iter()
        .find(|row| row.decision_ref.as_deref() == Some(reference)))
}

fn next_head(
    connection: &Connection,
    record: &DecisionRecord,
    direct: &str,
) -> CognitionResult<Option<DecisionPointer>> {
    if !(record.operation.is_some_and(DecisionOperation::undoes)
        && record.resulting_direct_redirect.as_deref() == Some(direct))
    {
        return Ok(record.previous_head.clone());
    }
    let Some(target) = &record.target_decision else {
        return Ok(None);
    };
    let (Some(job), Some(reference)) = (&target.job_ref, &target.decision_ref) else {
        return Ok(None);
    };
    Ok(find_record(connection, job, reference)?.and_then(|target| target.previous_head))
}

fn record_sources_current(
    connection: &Connection,
    canonical: &ConversationSourceReader,
    record: &DecisionRecord,
) -> CognitionResult<bool> {
    let bindings = record.source_bindings();
    if bindings.is_empty() {
        return Ok(false);
    }
    for binding in bindings {
        let Some(binding) = binding else {
            return Ok(false);
        };
        if !binding_current(connection, canonical, binding)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// A recorded source binding must still match its current row, chunk, and
/// canonical text.
fn binding_current(
    connection: &Connection,
    canonical: &ConversationSourceReader,
    binding: &DecisionSource,
) -> CognitionResult<bool> {
    let Some(reference) = binding.source_ref.as_deref() else {
        return Ok(false);
    };
    let Some(row) = source(connection, reference)? else {
        return Ok(false);
    };
    for (recorded, actual) in [
        (&binding.episode_id, row.episode_id.as_str()),
        (&binding.revision, row.revision.as_str()),
        (&binding.content_hash, row.content_hash.as_str()),
        (&binding.origin_kind, row.origin_kind.as_str()),
        (&binding.role, row.role.as_str()),
        (&binding.observed_at, row.observed_at.as_str()),
    ] {
        if recorded.as_deref() != Some(actual) {
            return Ok(false);
        }
    }
    if binding.byte_start != Some(row.byte_start)
        || binding.byte_end != Some(row.byte_end)
        || binding.session_id.as_deref() != row.conversation_session_id.as_deref()
    {
        return Ok(false);
    }
    let chunk = connection
        .query_row(
            "SELECT current_revision,project_id FROM memory_chunks WHERE memory_chunk_id=?1",
            [&row.episode_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    if !chunk.is_some_and(|(revision, project)| {
        revision == row.revision && project.as_deref() == binding.project_id.as_deref()
    }) {
        return Ok(false);
    }
    let Some(message_id) = &row.conversation_message_id else {
        return Ok(false);
    };
    let Ok(Some(message)) = canonical.read_message(message_id) else {
        return Ok(false);
    };
    let Ok(hydrated) = hydrate_conversation_source(&message, &row, f64::INFINITY) else {
        return Ok(false);
    };
    let quote = binding.quote.as_deref().unwrap_or("");
    if quote.is_empty() {
        return Ok(true);
    }
    let start = binding.quote_byte_start.unwrap_or(-1.0) - row.byte_start;
    let end = binding.quote_byte_end.unwrap_or(-1.0) - row.byte_start;
    if start < 0.0 || end < start {
        return Ok(false);
    }
    Ok(hydrated
        .text
        .as_bytes()
        .get(butler_core::json::saturating_usize(start)..butler_core::json::saturating_usize(end))
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        == Some(quote))
}

/// The job's stored decisions, each kept as stored; `None` when the job has
/// no row.
fn stored_items(connection: &Connection, job: &str) -> CognitionResult<Option<Vec<Box<RawValue>>>> {
    let stored = connection
        .query_row(
            "SELECT identity_decisions_json FROM memory_projection_jobs WHERE job_id=?1",
            [job],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    stored
        .map(|text| serde_json::from_str(&text).map_err(history_invalid))
        .transpose()
}

/// One stored decision. Every field reads leniently, so only an item that
/// is not an object fails; it reads as a decision without fields, as the
/// legacy reader saw it.
fn read_item(item: &RawValue) -> DecisionRecord {
    serde_json::from_str(item.get()).unwrap_or_default()
}

/// The job's stored decision records; a job without history has none.
pub(super) fn records_for_job(
    connection: &Connection,
    job: &str,
) -> CognitionResult<Vec<DecisionRecord>> {
    Ok(stored_items(connection, job)?
        .unwrap_or_default()
        .iter()
        .map(|item| read_item(item))
        .collect())
}

/// Appends `record` unless the job already has its decision. The job's
/// earlier decisions are rewritten exactly as stored.
pub(super) fn append_record(
    connection: &Connection,
    job: &str,
    record: &DecisionRecord,
) -> CognitionResult<()> {
    let Some(mut items) = stored_items(connection, job)? else {
        return Ok(());
    };
    if items
        .iter()
        .any(|item| read_item(item).decision_ref == record.decision_ref)
    {
        return Ok(());
    }
    items.push(serde_json::value::to_raw_value(record).map_err(history_invalid)?);
    let text = serde_json::to_string(&items).map_err(history_invalid)?;
    connection
        .execute(
            "UPDATE memory_projection_jobs SET identity_decisions_json=?1 WHERE job_id=?2",
            params![text, job],
        )
        .map_err(db_error)?;
    Ok(())
}

fn history_invalid(error: serde_json::Error) -> CognitionError {
    CognitionError::new(
        CognitionCode::MemoryIdentityHistoryInvalid,
        error.to_string(),
    )
    .with_source(error)
}
