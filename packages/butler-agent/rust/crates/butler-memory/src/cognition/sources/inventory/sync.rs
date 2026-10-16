//! Bounded steps that bring the graph's inventory mirror up to the canonical
//! store: an initial build that pages every turn outcome and recovered
//! message, then the source changes after the watermark.

use butler_turn::conversation::{ConversationSourceReader, SourceChangeKind};
use indexmap::{IndexMap, IndexSet};

use super::{
    CandidateKind, InventoryCandidate, recovered_candidate, source_key, turn_candidate, unavailable,
};
use crate::cognition::CognitionResult;
use crate::cognition::graph::{GraphRepository, InventoryPhase, InventoryState, InventoryWrite};

/// Sources read per build step.
const PAGE: usize = 500;
/// Source changes applied per step.
const CHANGES: usize = 512;

/// The store's identity and change head; `None` for a store that does not
/// record source changes.
fn source_position(reader: &ConversationSourceReader) -> CognitionResult<Option<(String, u64)>> {
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

/// The stored state when it still describes this store.
fn current(state: Option<InventoryState>, identity: &str, head: u64) -> Option<InventoryState> {
    state.filter(|state| state.identity == identity && state.seq <= head)
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
    Ok(current(graph.canonical_inventory_state()?, &identity, head)
        .is_none_or(|state| state.phase != InventoryPhase::Ready || state.seq < head))
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
    let Some(state) = current(graph.canonical_inventory_state()?, &identity, head) else {
        // Changes after `head` are applied once the build is done.
        graph.write_canonical_inventory(&InventoryWrite {
            reset: true,
            upserts: Vec::new(),
            deletes: Vec::new(),
            state: InventoryState {
                identity,
                seq: head,
                phase: InventoryPhase::Outcomes(None),
            },
        })?;
        return Ok(true);
    };
    let write = match &state.phase {
        InventoryPhase::Outcomes(cursor) => build_outcomes(reader, &state, cursor.as_deref())?,
        InventoryPhase::Messages(cursor) => build_messages(reader, &state, cursor.as_deref())?,
        InventoryPhase::Ready if state.seq >= head => return Ok(false),
        InventoryPhase::Ready => apply_changes(graph, reader, &state)?,
    };
    let more = write.state.phase != InventoryPhase::Ready || write.state.seq < head;
    graph.write_canonical_inventory(&write)?;
    Ok(more)
}

fn build_outcomes(
    reader: &ConversationSourceReader,
    state: &InventoryState,
    cursor: Option<&str>,
) -> CognitionResult<InventoryWrite> {
    let outcomes = reader
        .read_recall_outcome_page(cursor, Some(PAGE))
        .map_err(unavailable)?;
    let upserts = outcomes
        .iter()
        .map(|outcome| turn_candidate(reader, outcome))
        .collect::<CognitionResult<Vec<_>>>()?;
    let phase = match outcomes.last() {
        Some(last) if outcomes.len() == PAGE => InventoryPhase::Outcomes(Some(last.id.clone())),
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
        if let Some(message) = reader.read_recovered_source(id).map_err(unavailable)? {
            upserts.push(recovered_candidate(&message)?);
        }
    }
    let phase = match ids.last() {
        Some(last) if ids.len() == PAGE => InventoryPhase::Messages(Some(last.clone())),
        _ => InventoryPhase::Ready,
    };
    Ok(build_write(state, upserts, phase))
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
        .read_source_changes(state.seq, CHANGES)
        .map_err(unavailable)?;
    let seq = changes.last().map_or(state.seq, |change| change.seq);
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
        match reader.read_recall_outcome(turn).map_err(unavailable)? {
            Some(outcome) => {
                let candidate = turn_candidate(reader, &outcome)?;
                upserts.insert(candidate.key(), candidate);
            }
            None => deletes.push(source_key(CandidateKind::Turn, turn)),
        }
    }
    for message in &messages {
        match reader.read_recovered_source(message).map_err(unavailable)? {
            Some(message) => {
                let candidate = recovered_candidate(&message)?;
                upserts.insert(candidate.key(), candidate);
            }
            None => deletes.push(source_key(CandidateKind::Message, message)),
        }
    }
    Ok(InventoryWrite {
        reset: false,
        upserts: upserts.into_values().collect(),
        deletes,
        state: InventoryState {
            seq,
            ..state.clone()
        },
    })
}
