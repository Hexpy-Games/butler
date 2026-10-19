//! Bounded steps that bring the graph's inventory mirror up to the canonical
//! store: an initial build that pages every turn outcome and recovered
//! message, then the logged source changes after the watermark. A source the
//! store cannot read is kept as a fault row, so one bad row never stops the
//! mirror; recall reports it where the full scan would.

use butler_turn::conversation::{ConversationSourceReader, SourceChangeKind, SourceChangeMark};
use indexmap::{IndexMap, IndexSet};

use super::{
    CandidateKind, InventoryCandidate, faulted, recovered_candidate, source_key, turn_or_fault,
    unavailable,
};
use crate::cognition::CognitionResult;
use crate::cognition::graph::{GraphRepository, InventoryPhase, InventoryState, InventoryWrite};

/// Sources read per build step.
const PAGE: usize = 500;
/// Source changes applied per step.
const CHANGES: usize = 512;

/// The store's identity and latest change; `None` for a store that does not
/// log source changes.
fn source_position(
    reader: &ConversationSourceReader,
) -> CognitionResult<Option<(String, SourceChangeMark)>> {
    Ok(
        match (
            reader.source_identity().map_err(unavailable)?,
            reader.source_change_head().map_err(unavailable)?,
        ) {
            (Some(identity), Some(head)) => Some((identity, head)),
            _ => None,
        },
    )
}

/// The stored state when it still describes this store: the same identity
/// and a change log that still continues from its watermark.
fn current(
    state: Option<InventoryState>,
    reader: &ConversationSourceReader,
    identity: &str,
) -> CognitionResult<Option<InventoryState>> {
    match state {
        Some(state)
            if state.identity == identity
                && reader
                    .source_change_holds(&state.mark)
                    .map_err(unavailable)? =>
        {
            Ok(Some(state))
        }
        _ => Ok(None),
    }
}

/// Whether a step has work: a missing or foreign mirror, an unfinished
/// build, or changes after the watermark. Reads only.
pub(in crate::cognition) fn sync_needed(
    graph: &GraphRepository,
    reader: &ConversationSourceReader,
) -> CognitionResult<bool> {
    let Some((identity, head)) = source_position(reader)? else {
        return Ok(false);
    };
    Ok(
        current(graph.canonical_inventory_state()?, reader, &identity)?
            .is_none_or(|state| state.phase != InventoryPhase::Ready || state.mark.seq < head.seq),
    )
}

/// Applies one step in one transaction; true while more steps remain.
pub(in crate::cognition) fn sync_step(
    graph: &mut GraphRepository,
    reader: &ConversationSourceReader,
) -> CognitionResult<bool> {
    let Some((identity, head)) = source_position(reader)? else {
        return Ok(false);
    };
    graph.install_canonical_inventory()?;
    let Some(state) = current(graph.canonical_inventory_state()?, reader, &identity)? else {
        // Changes after `head` are applied once the build is done.
        graph.write_canonical_inventory(&InventoryWrite {
            reset: true,
            upserts: Vec::new(),
            deletes: Vec::new(),
            state: InventoryState {
                identity,
                mark: head,
                phase: InventoryPhase::Outcomes(None),
            },
        })?;
        return Ok(true);
    };
    let write = match &state.phase {
        InventoryPhase::Outcomes(cursor) => build_outcomes(reader, &state, cursor.as_deref())?,
        InventoryPhase::Messages(cursor) => build_messages(reader, &state, cursor.as_deref())?,
        InventoryPhase::Ready if state.mark.seq >= head.seq => return Ok(false),
        InventoryPhase::Ready => apply_changes(graph, reader, &state)?,
    };
    let more = write.state.phase != InventoryPhase::Ready || write.state.mark.seq < head.seq;
    graph.write_canonical_inventory(&write)?;
    Ok(more)
}

fn build_outcomes(
    reader: &ConversationSourceReader,
    state: &InventoryState,
    cursor: Option<&str>,
) -> CognitionResult<InventoryWrite> {
    let entries = reader
        .read_recall_outcome_entries(cursor, Some(PAGE))
        .map_err(unavailable)?;
    let upserts = entries
        .iter()
        .map(|entry| match &entry.row {
            Ok(outcome) => turn_or_fault(reader, outcome),
            Err(error) => faulted(
                CandidateKind::Turn,
                &entry.turn_id,
                &entry.session_id,
                error.to_string(),
                true,
            ),
        })
        .collect();
    let phase = match entries.last() {
        Some(last) if entries.len() == PAGE => InventoryPhase::Outcomes(Some(last.id.clone())),
        _ => InventoryPhase::Messages(None),
    };
    Ok(build_write(state, upserts, phase))
}

fn build_messages(
    reader: &ConversationSourceReader,
    state: &InventoryState,
    cursor: Option<&str>,
) -> CognitionResult<InventoryWrite> {
    let ids = reader
        .read_recovered_source_ids_page(cursor, Some(PAGE))
        .map_err(unavailable)?;
    let mut upserts = Vec::with_capacity(ids.len());
    for id in &ids {
        upserts.extend(recovered_row(reader, id));
    }
    let phase = match ids.last() {
        Some(last) if ids.len() == PAGE => InventoryPhase::Messages(Some(last.clone())),
        _ => InventoryPhase::Ready,
    };
    Ok(build_write(state, upserts, phase))
}

/// The row of a recovered message; `None` when the message is no longer one.
fn recovered_row(reader: &ConversationSourceReader, id: &str) -> Option<InventoryCandidate> {
    match reader.read_recovered_source(id) {
        Ok(message) => message.map(|message| {
            recovered_candidate(&message).unwrap_or_else(|error| {
                let session = &message.message.session_id;
                faulted(
                    CandidateKind::Message,
                    id,
                    session,
                    error.message().clone(),
                    true,
                )
            })
        }),
        Err(error) => Some(faulted(
            CandidateKind::Message,
            id,
            "",
            error.to_string(),
            true,
        )),
    }
}

/// The row of a turn; `None` when the turn has no outcome.
fn turn_row(reader: &ConversationSourceReader, turn: &str) -> Option<InventoryCandidate> {
    match reader.read_recall_outcome(turn) {
        Ok(outcome) => outcome.map(|outcome| turn_or_fault(reader, &outcome)),
        Err(error) => Some(faulted(
            CandidateKind::Turn,
            turn,
            "",
            error.to_string(),
            true,
        )),
    }
}

fn build_write(
    state: &InventoryState,
    upserts: Vec<InventoryCandidate>,
    phase: InventoryPhase,
) -> InventoryWrite {
    InventoryWrite {
        reset: false,
        upserts,
        deletes: Vec::new(),
        state: InventoryState {
            phase,
            ..state.clone()
        },
    }
}

/// Re-reads every source the next changes name; a source that is gone or
/// no longer qualifies loses its row.
fn apply_changes(
    graph: &GraphRepository,
    reader: &ConversationSourceReader,
    state: &InventoryState,
) -> CognitionResult<InventoryWrite> {
    let changes = reader
        .read_source_changes(state.mark.seq, CHANGES)
        .map_err(unavailable)?;
    let mark = changes.last().map_or_else(
        || state.mark.clone(),
        |change| SourceChangeMark {
            seq: change.seq,
            key: format!("{}:{}", kind_name(change.kind), change.entity_id),
        },
    );
    let mut turns = IndexSet::new();
    let mut messages = IndexSet::new();
    for change in changes {
        match change.kind {
            SourceChangeKind::Turn => turns.insert(change.entity_id),
            SourceChangeKind::Message => messages.insert(change.entity_id),
        };
    }
    for message in &messages {
        turns.extend(graph.canonical_inventory_referencing(message)?);
    }
    let mut upserts = IndexMap::new();
    let mut deletes = Vec::new();
    for turn in &turns {
        match turn_row(reader, turn) {
            Some(candidate) => upserts.insert(candidate.key(), candidate),
            None => {
                deletes.push(source_key(CandidateKind::Turn, turn));
                None
            }
        };
    }
    for message in &messages {
        match recovered_row(reader, message) {
            Some(candidate) => upserts.insert(candidate.key(), candidate),
            None => {
                deletes.push(source_key(CandidateKind::Message, message));
                None
            }
        };
    }
    Ok(InventoryWrite {
        reset: false,
        upserts: upserts.into_values().collect(),
        deletes,
        state: InventoryState {
            mark,
            ..state.clone()
        },
    })
}

fn kind_name(kind: SourceChangeKind) -> &'static str {
    match kind {
        SourceChangeKind::Turn => "turn",
        SourceChangeKind::Message => "message",
    }
}
