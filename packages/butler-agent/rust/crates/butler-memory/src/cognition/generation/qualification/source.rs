//! The source inventory a qualification is checked against.

mod inventory;

pub(super) use inventory::EvidenceInventory;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

use crate::cognition::CognitionResult;

use super::{
    CaptureStore,
    io::{self, sha256},
    types::{
        QueryObservation, SourceBinding, SourceIdentity, SourceObservation, SourceRead, SourceRow,
    },
};

pub(super) struct ReturnedResult<'a> {
    pub result_id: &'a str,
    pub source_handles: &'a [String],
    pub observations: &'a [QueryObservation],
}

/// A source leaf an inventory must list.
struct RawSourceFact<'a> {
    source_id: &'a str,
    revision: &'a str,
    source_hash: &'a str,
    episode_id: &'a str,
}

impl<'a> RawSourceFact<'a> {
    /// The leaf `source_id` carrying the row's revision, hash, and episode.
    fn of(row: &'a SourceRow, source_id: &'a str) -> Self {
        Self {
            source_id,
            revision: &row.revision,
            source_hash: &row.content_hash,
            episode_id: &row.episode_id,
        }
    }
}

pub(super) fn inventory_contains_source_observation(
    inventory: &EvidenceInventory,
    source: &SourceObservation,
    generation_id: &str,
    results: &[ReturnedResult<'_>],
    capture: &mut CaptureStore,
) -> CognitionResult<bool> {
    let binding: SourceBinding = capture.read_json(&source.binding_ref, &source.binding_sha256)?;
    let read_evidence: SourceRead =
        capture.read_json(&binding.read_result_ref, &binding.read_result_sha256)?;
    if binding.schema != "butler.memory-source-binding-evidence.v1"
        || binding.handle != source.handle
        || binding.generation_id != generation_id
        || binding.inventory_hash != source.inventory_hash
        || binding.revision != source.revision
        || binding.source_hash != source.source_hash
        || binding.observed_at != source.observed_at
        || binding.currentness != source.currentness
        || !results.iter().any(|result| {
            result.result_id == binding.returned_in_result_id
                && binding_returned_by_result(&binding, result)
        })
        || !io::valid_sha(&binding.read_result_sha256)
    {
        return Ok(false);
    }
    match &source.identity {
        SourceIdentity::MemorySource { source_id } => {
            if binding
                .source_row
                .as_ref()
                .is_none_or(|row| row.source_id != *source_id)
            {
                return Ok(false);
            }
        }
        SourceIdentity::ConversationSource {
            message_id,
            part_id,
            scalar_pointer,
        } => {
            if binding.canonical.as_ref().is_none_or(|canonical| {
                canonical.message_id != *message_id
                    || canonical.part_id != *part_id
                    || canonical.scalar_pointer != *scalar_pointer
            }) {
                return Ok(false);
            }
        }
    }
    Ok(valid_source_read_evidence(&binding, &read_evidence)
        && source_binding_belongs_to_inventory(&binding, inventory, generation_id))
}

pub(super) fn valid_source_read_evidence(binding: &SourceBinding, evidence: &SourceRead) -> bool {
    let Some(row) = binding.source_row.as_ref() else {
        return false;
    };
    let canonical = &evidence.canonical;
    if binding.handle.is_empty()
        || binding.observation_kind == "source_ref"
            && binding.returned_source_ref.as_deref() != Some(binding.handle.as_str())
        || evidence.schema != "butler.memory-source-read-evidence.v1"
        || evidence.result_id != binding.returned_in_result_id
        || evidence.observation_kind != binding.observation_kind
        || evidence.source_ref != binding.returned_source_ref
        || evidence.message_id != binding.returned_message_id
        || evidence.source_row != *row
        || canonical.revision != binding.revision
        || canonical.sha256 != binding.source_hash
        || canonical.bytes != canonical.text.len() as u64
        || sha256(canonical.text.as_bytes()) != canonical.sha256
        || row.revision != canonical.revision
        || row.content_hash != canonical.sha256
        || row.conversation_message_id != canonical.message_id
        || row.part_id != canonical.part_id
        || row.scalar_pointer != canonical.scalar_pointer
    {
        return false;
    }
    if let Some(source) = &binding.canonical
        && (source.message_id != canonical.message_id.as_deref().unwrap_or_default()
            || source.part_id != canonical.part_id.as_deref().unwrap_or_default()
            || source.scalar_pointer != canonical.scalar_pointer.as_deref().unwrap_or_default()
            || source.scalar_hash != canonical.sha256
            || source.revision != canonical.revision)
    {
        return false;
    }
    row.byte_start >= 0
        && row.byte_end <= i64::try_from(canonical.bytes).unwrap_or(i64::MAX)
        && row.byte_start < row.byte_end
        && evidence.returned_text == canonical.text
}

pub(super) fn binding_returned_by_result(
    binding: &SourceBinding,
    result: &ReturnedResult<'_>,
) -> bool {
    match binding.observation_kind.as_str() {
        "source_ref" => binding.returned_source_ref.as_ref().is_some_and(|source_ref| {
            binding.returned_message_id.is_none()
                && result.source_handles.contains(source_ref)
                && result.observations.iter().any(|observation| {
                    matches!(observation, QueryObservation::SourceRef { source_ref: found } if found == source_ref)
                })
        }),
        "session_message" => binding.returned_message_id.as_ref().is_some_and(|message_id| {
            binding.returned_source_ref.is_none()
                && result.observations.iter().any(|observation| {
                    matches!(observation, QueryObservation::SessionMessage { message_id: found } if found == message_id)
                })
        }),
        _ => false,
    }
}

/// A binding belongs to an inventory when its returned handle decodes to a
/// source leaf (directly or through split ancestry) that the inventory lists.
pub(super) fn source_binding_belongs_to_inventory(
    binding: &SourceBinding,
    inventory: &EvidenceInventory,
    generation_id: &str,
) -> bool {
    if binding.schema != "butler.memory-source-binding-evidence.v1"
        || binding.generation_id != generation_id
        || !io::valid_sha(&binding.inventory_hash)
        || !io::valid_sha(&binding.revision)
        || !io::valid_sha(&binding.source_hash)
        || !valid_timestamp(&binding.observed_at)
        || !matches!(
            binding.currentness.as_str(),
            "current" | "historical" | "as_of"
        )
    {
        return false;
    }
    match (
        binding.observation_kind.as_str(),
        binding.returned_source_ref.as_deref(),
    ) {
        ("source_ref", Some(source_ref)) if source_ref.starts_with("memory-source:v2:") => {
            memory_source_belongs(binding, source_ref, inventory, generation_id)
        }
        ("source_ref", Some(source_ref)) if source_ref.starts_with("conversation-source:v2:") => {
            conversation_source_belongs(binding, source_ref, inventory)
        }
        ("session_message", _) => session_message_belongs(binding, inventory),
        _ => false,
    }
}

/// `memory-source:v2:<generation>:<source id>`: the row must be current and,
/// for a split leaf, its ancestry must reach an inventory leaf.
fn memory_source_belongs(
    binding: &SourceBinding,
    source_ref: &str,
    inventory: &EvidenceInventory,
    generation_id: &str,
) -> bool {
    let parts = source_ref.split(':').collect::<Vec<_>>();
    let [_, _, generation, source_id] = parts.as_slice() else {
        return false;
    };
    if decode_base64url(generation).as_deref() != Some(generation_id) {
        return false;
    }
    let (Some(source_id), Some(row)) = (decode_base64url(source_id), binding.source_row.as_ref())
    else {
        return false;
    };
    if !memory_row_current(binding, row, &source_id) {
        return false;
    }
    if inventory.contains_raw_source_fact(&RawSourceFact::of(row, &source_id)) {
        return true;
    }
    split_root(binding, row, &source_id).is_some_and(|root| {
        root != source_id && inventory.contains_raw_source_fact(&RawSourceFact::of(row, &root))
    })
}

fn memory_row_current(binding: &SourceBinding, row: &SourceRow, source_id: &str) -> bool {
    if row.source_id != source_id
        || row.revision != binding.revision
        || row.content_hash != binding.source_hash
        || binding
            .chunk
            .as_ref()
            .is_none_or(|chunk| chunk.current_revision != row.revision || chunk.status != "active")
        || row.episode_id.is_empty()
        || row.observed_at != binding.observed_at
        || !valid_timestamp(&row.conversation_start)
        || !valid_timestamp(&row.conversation_end)
        || row.byte_start < 0
        || row.byte_end <= row.byte_start
    {
        return false;
    }
    row.conversation_message_id.is_none()
        || binding.canonical.as_ref().is_some_and(|canonical| {
            Some(canonical.message_id.as_str()) == row.conversation_message_id.as_deref()
                && Some(canonical.part_id.as_str()) == row.part_id.as_deref()
                && Some(canonical.scalar_pointer.as_str()) == row.scalar_pointer.as_deref()
                && canonical.scalar_hash == row.content_hash
                && canonical.revision == row.revision
        })
}

/// Walks the split ancestry up from the leaf; each ancestor must share the
/// leaf's source and contain its child. Returns the topmost source id.
fn split_root(binding: &SourceBinding, row: &SourceRow, source_id: &str) -> Option<String> {
    let mut child_id = source_id.to_owned();
    let (mut child_start, mut child_end) = (row.byte_start, row.byte_end);
    for ancestor in binding.split_ancestry.as_deref().unwrap_or_default() {
        if !io::valid_sha(&ancestor.revision)
            || !io::valid_sha(&ancestor.content_hash)
            || ancestor.episode_id != row.episode_id
            || ancestor.revision != row.revision
            || ancestor.content_hash != row.content_hash
            || ancestor.conversation_session_id != row.conversation_session_id
            || ancestor.conversation_message_id != row.conversation_message_id
            || ancestor.part_id != row.part_id
            || ancestor.scalar_pointer != row.scalar_pointer
            || !ancestor.child_source_ids.contains(&child_id)
            || ancestor.byte_start > child_start
            || ancestor.byte_end < child_end
        {
            return None;
        }
        child_id.clone_from(&ancestor.source_id);
        child_start = ancestor.byte_start;
        child_end = ancestor.byte_end;
    }
    Some(child_id)
}

/// `conversation-source:v2:<message>:<part>:<pointer>:<hash>`: the canonical
/// scalar and the row must name the same source.
fn conversation_source_belongs(
    binding: &SourceBinding,
    source_ref: &str,
    inventory: &EvidenceInventory,
) -> bool {
    let parts = source_ref.split(':').collect::<Vec<_>>();
    let [_, _, message, part, pointer, hash] = parts.as_slice() else {
        return false;
    };
    let Some(canonical) = binding.canonical.as_ref() else {
        return false;
    };
    if *hash != binding.source_hash
        || decode_base64url(message).as_deref() != Some(canonical.message_id.as_str())
        || decode_base64url(part).as_deref() != Some(canonical.part_id.as_str())
        || decode_base64url(pointer).as_deref() != Some(canonical.scalar_pointer.as_str())
        || canonical.scalar_hash != binding.source_hash
        || canonical.revision != binding.revision
    {
        return false;
    }
    binding.source_row.as_ref().is_some_and(|row| {
        row.revision == binding.revision
            && row.content_hash == binding.source_hash
            && canonical_row_listed(binding, canonical, row, inventory)
    })
}

/// A returned session message must be the canonical scalar of the row.
fn session_message_belongs(binding: &SourceBinding, inventory: &EvidenceInventory) -> bool {
    let (Some(message_id), Some(canonical), Some(row)) = (
        binding.returned_message_id.as_deref(),
        binding.canonical.as_ref(),
        binding.source_row.as_ref(),
    ) else {
        return false;
    };
    message_id == canonical.message_id
        && canonical.revision == binding.revision
        && canonical.scalar_hash == binding.source_hash
        && row.revision == canonical.revision
        && row.content_hash == canonical.scalar_hash
        && canonical_row_listed(binding, canonical, row, inventory)
}

fn canonical_row_listed(
    binding: &SourceBinding,
    canonical: &super::types::CanonicalSource,
    row: &SourceRow,
    inventory: &EvidenceInventory,
) -> bool {
    row.observed_at == binding.observed_at
        && row.conversation_message_id.as_deref() == Some(canonical.message_id.as_str())
        && row.part_id.as_deref() == Some(canonical.part_id.as_str())
        && row.scalar_pointer.as_deref() == Some(canonical.scalar_pointer.as_str())
        && inventory.contains_raw_source_fact(&RawSourceFact::of(row, &row.source_id))
}

fn decode_base64url(value: &str) -> Option<String> {
    URL_SAFE_NO_PAD
        .decode(value)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

pub(super) fn valid_timestamp(value: &str) -> bool {
    timestamp_millis(value).is_some()
}

pub(super) fn timestamp_millis(value: &str) -> Option<i64> {
    butler_core::js_date::parse_date_millis(value, &|local| Some(local))
}
