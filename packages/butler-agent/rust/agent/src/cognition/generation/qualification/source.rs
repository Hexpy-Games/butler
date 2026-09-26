use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};

use crate::cognition::CognitionResult;

use super::{
    CaptureStore, invalid,
    io::{self, sha256},
    types::{QueryObservation, SourceBinding, SourceIdentity, SourceObservation, SourceRead},
};

pub(super) struct ReturnedResult<'a> {
    pub result_id: &'a str,
    pub source_handles: &'a [String],
    pub observations: &'a [QueryObservation],
}

pub(super) fn memory_inventory_hash(inventory: &Value) -> CognitionResult<String> {
    let origin_version = inventory
        .get("origin")
        .and_then(|value| value.get("version"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut normalized = serde_json::Map::new();
    if let Some(schema) = inventory.get("schema") {
        normalized.insert("schema".to_owned(), schema.clone());
    }
    normalized.insert("origin_version".to_owned(), origin_version);
    for (field, fallback) in [
        ("exclusions", json!({})),
        ("entries", json!([])),
        ("typed", json!([])),
        ("typed_lifecycle", json!([])),
        ("history", json!([])),
    ] {
        let value = inventory
            .get(field)
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or(fallback);
        normalized.insert(field.to_owned(), value);
    }
    let serialized = crate::json::stringify(&Value::Object(normalized))
        .map_err(|_| invalid("memory_acceptance_evidence_invalid"))?;
    Ok(sha256(serialized.as_bytes()))
}

pub(super) fn inventory_contains_source_observation(
    inventory: &Value,
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

pub(super) fn source_binding_belongs_to_inventory(
    binding: &SourceBinding,
    inventory: &Value,
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

    if binding.observation_kind == "source_ref"
        && let Some(source_ref) = binding.returned_source_ref.as_deref()
        && source_ref.starts_with("memory-source:v2:")
    {
        let parts = source_ref.split(':').collect::<Vec<_>>();
        if parts.len() != 4 || decode_base64url(parts[2]).as_deref() != Some(generation_id) {
            return false;
        }
        let source_id = match decode_base64url(parts[3]) {
            Some(value) => value,
            None => return false,
        };
        let Some(row) = binding.source_row.as_ref() else {
            return false;
        };
        if row.source_id != source_id
            || row.revision != binding.revision
            || row.content_hash != binding.source_hash
            || binding.chunk.as_ref().is_none_or(|chunk| {
                chunk.current_revision != row.revision || chunk.status != "active"
            })
            || row.episode_id.is_empty()
            || row.observed_at != binding.observed_at
            || !valid_timestamp(&row.conversation_start)
            || !valid_timestamp(&row.conversation_end)
            || row.byte_start < 0
            || row.byte_end <= row.byte_start
        {
            return false;
        }
        if row.conversation_message_id.is_some()
            && binding.canonical.as_ref().is_none_or(|canonical| {
                Some(canonical.message_id.as_str()) != row.conversation_message_id.as_deref()
                    || Some(canonical.part_id.as_str()) != row.part_id.as_deref()
                    || Some(canonical.scalar_pointer.as_str()) != row.scalar_pointer.as_deref()
                    || canonical.scalar_hash != row.content_hash
                    || canonical.revision != row.revision
            })
        {
            return false;
        }
        if inventory_contains_raw_source_fact(
            inventory,
            &source_id,
            &row.revision,
            &row.content_hash,
            &row.episode_id,
        ) {
            return true;
        }
        let mut child_id = source_id.clone();
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
                return false;
            }
            child_id = ancestor.source_id.clone();
            child_start = ancestor.byte_start;
            child_end = ancestor.byte_end;
        }
        return child_id != source_id
            && inventory_contains_raw_source_fact(
                inventory,
                &child_id,
                &row.revision,
                &row.content_hash,
                &row.episode_id,
            );
    }

    if binding.observation_kind == "source_ref"
        && let Some(source_ref) = binding.returned_source_ref.as_deref()
        && source_ref.starts_with("conversation-source:v2:")
    {
        let parts = source_ref.split(':').collect::<Vec<_>>();
        let Some(canonical) = binding.canonical.as_ref() else {
            return false;
        };
        if parts.len() != 6
            || parts[5] != binding.source_hash
            || decode_base64url(parts[2]).as_deref() != Some(canonical.message_id.as_str())
            || decode_base64url(parts[3]).as_deref() != Some(canonical.part_id.as_str())
            || decode_base64url(parts[4]).as_deref() != Some(canonical.scalar_pointer.as_str())
            || canonical.scalar_hash != binding.source_hash
            || canonical.revision != binding.revision
        {
            return false;
        }
        let Some(row) = binding.source_row.as_ref() else {
            return false;
        };
        return row.revision == binding.revision
            && row.content_hash == binding.source_hash
            && row.observed_at == binding.observed_at
            && row.conversation_message_id.as_deref() == Some(canonical.message_id.as_str())
            && row.part_id.as_deref() == Some(canonical.part_id.as_str())
            && row.scalar_pointer.as_deref() == Some(canonical.scalar_pointer.as_str())
            && inventory_contains_raw_source_fact(
                inventory,
                &row.source_id,
                &row.revision,
                &row.content_hash,
                &row.episode_id,
            );
    }

    if binding.observation_kind == "session_message" {
        let (Some(message_id), Some(canonical), Some(row)) = (
            binding.returned_message_id.as_deref(),
            binding.canonical.as_ref(),
            binding.source_row.as_ref(),
        ) else {
            return false;
        };
        return message_id == canonical.message_id
            && canonical.revision == binding.revision
            && canonical.scalar_hash == binding.source_hash
            && row.revision == canonical.revision
            && row.content_hash == canonical.scalar_hash
            && row.observed_at == binding.observed_at
            && row.conversation_message_id.as_deref() == Some(canonical.message_id.as_str())
            && row.part_id.as_deref() == Some(canonical.part_id.as_str())
            && row.scalar_pointer.as_deref() == Some(canonical.scalar_pointer.as_str())
            && inventory_contains_raw_source_fact(
                inventory,
                &row.source_id,
                &row.revision,
                &row.content_hash,
                &row.episode_id,
            );
    }
    false
}

fn inventory_contains_raw_source_fact(
    inventory: &Value,
    source_id: &str,
    revision: &str,
    source_hash: &str,
    episode_id: &str,
) -> bool {
    inventory
        .get("entries")
        .and_then(Value::as_array)
        .is_some_and(|entries| {
            entries.iter().any(|entry| {
                entry.get("episodeId").and_then(Value::as_str) == Some(episode_id)
                    && entry.get("revision").and_then(Value::as_str) == Some(revision)
                    && string_array_contains(entry.get("sourceIds"), source_id)
                    && string_array_contains(entry.get("sourceHashes"), source_hash)
            })
        })
        || inventory
            .get("typed")
            .and_then(Value::as_array)
            .is_some_and(|entries| {
                entries.iter().any(|entry| {
                    entry.get("revision").and_then(Value::as_str) == Some(revision)
                        && entry.get("content_hash").and_then(Value::as_str) == Some(source_hash)
                        && string_array_contains(entry.get("source_ids"), source_id)
                })
            })
        || inventory
            .get("history")
            .and_then(Value::as_array)
            .is_some_and(|entries| {
                entries.iter().any(|entry| {
                    entry.get("source_ref").and_then(Value::as_str) == Some(source_id)
                        && entry.get("revision").and_then(Value::as_str) == Some(revision)
                        && entry.get("source_hash").and_then(Value::as_str) == Some(source_hash)
                })
            })
}

fn string_array_contains(value: Option<&Value>, expected: &str) -> bool {
    value
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(expected)))
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
    crate::js_date::parse_date_millis(value, &|local| Some(local))
}
