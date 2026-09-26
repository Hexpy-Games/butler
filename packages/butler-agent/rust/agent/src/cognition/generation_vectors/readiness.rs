//! Read-only physical witness for complete rebuild vector units.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use chrono::{DateTime, SecondsFormat, Utc};
use futures_util::TryStreamExt;
use lancedb::{
    Error as LanceError,
    query::{ExecutableQuery, QueryBase, Select},
};
use serde_json::Value;

use super::rows::{COLUMNS, GenerationVectorRow, optional_text, text};
use crate::cognition::{
    CognitionResult, MemoryGenerationHandle, ensure_data_authority, graph::VectorReadinessRow,
    lance_store,
};

const CHUNK: usize = 100;

struct Expected {
    row: GenerationVectorRow,
    units: Vec<usize>,
}

pub(crate) async fn invalid_persisted_rebuild_vectors(
    data_root: &Path,
    generation: &MemoryGenerationHandle,
    units: &[VectorReadinessRow],
    historical: &HashSet<String>,
) -> CognitionResult<usize> {
    if units.is_empty() {
        return Ok(0);
    }
    let Some(version) = generation.embedding.as_ref().map(|value| value.version()) else {
        return Ok(units.len());
    };
    let root = generation.root.join("butler.lance");
    ensure_data_authority(
        data_root,
        &[&generation.root, &root, &root.join("butler_memory.lance")],
    )?;
    let mut invalid = HashSet::new();
    let mut groups: HashMap<String, Vec<Expected>> = HashMap::new();
    for (index, unit) in units.iter().enumerate() {
        let (chunk, key) = GenerationVectorRow::identity(
            &generation.generation_id,
            &unit.record_kind,
            &unit.owner_id,
            &unit.owner_revision,
            &unit.projection_text,
            version,
        );
        if unit.source_membership_invalid
            || !receipt_matches(unit, &generation.generation_id, version, &key)
            || !source_refs_current(unit, historical)
        {
            invalid.insert(index);
        }
        let Some(source_kind) = unit.source_kind.as_ref() else {
            invalid.insert(index);
            continue;
        };
        let Some(observed) = unit
            .source_observed_at
            .as_ref()
            .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
        else {
            invalid.insert(index);
            continue;
        };
        let Some(refs) = unit.source_ids_json.as_ref() else {
            invalid.insert(index);
            continue;
        };
        let expected = GenerationVectorRow {
            vector_key: key.clone(),
            generation: generation.generation_id.clone(),
            record_kind: unit.record_kind.clone(),
            owner_id: unit.owner_id.clone(),
            owner_revision: unit.owner_revision.clone(),
            source_revision: unit.source_revision.clone(),
            embedding_chunk_id: chunk,
            embedding_version: version.to_owned(),
            project_id: unit.project_id.clone().unwrap_or_default(),
            origin_kind: unit.origin_kind.clone(),
            source_kind: source_kind.clone(),
            conversation_session_id: unit.conversation_session_id.clone(),
            source_observed_at: observed
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true),
            source_refs_json: refs.clone(),
            vector: Vec::new(),
        };
        groups.entry(key).or_default().push(Expected {
            row: expected,
            units: vec![index],
        });
    }
    if !root.exists() {
        return Ok(units.len());
    }
    let connection = match lance_store::connect(&root).await {
        Ok(value) => value,
        Err(_) => return Ok(units.len()),
    };
    let table = match lance_store::open(&connection, "butler_memory").await {
        Ok(value) => value,
        Err(LanceError::TableNotFound { .. }) => return Ok(units.len()),
        Err(_) => return Ok(units.len()),
    };
    let keys = groups.keys().cloned().collect::<Vec<_>>();
    for chunk in keys.chunks(CHUNK) {
        let predicate = format!(
            "vector_key IN ({})",
            chunk
                .iter()
                .map(|key| format!("'{key}'"))
                .collect::<Vec<_>>()
                .join(",")
        );
        let batches = match table
            .query()
            .only_if(predicate)
            .select(Select::columns(&COLUMNS[..15]))
            .limit(chunk.len() + 1)
            .execute()
            .await
        {
            Ok(stream) => match stream.try_collect::<Vec<_>>().await {
                Ok(value) => value,
                Err(_) => return Ok(units.len()),
            },
            Err(_) => return Ok(units.len()),
        };
        let mut seen: HashMap<String, Vec<[Option<String>; 15]>> = HashMap::new();
        for batch in batches {
            for index in 0..batch.num_rows() {
                let key = text(&batch, 0, index)?;
                let mut values: [Option<String>; 15] = std::array::from_fn(|_| None);
                for (column, value) in values.iter_mut().enumerate() {
                    *value = optional_text(&batch, column, index)?;
                }
                seen.entry(key).or_default().push(values);
            }
        }
        for key in chunk {
            let Some(expectations) = groups.get(key) else {
                continue;
            };
            let physical = seen.get(key);
            let matches = physical.is_some_and(|rows| {
                rows.len() == 1
                    && expectations
                        .iter()
                        .any(|expected| metadata_matches(&rows[0], &expected.row))
            });
            if !matches {
                for expected in expectations {
                    invalid.extend(expected.units.iter().copied());
                }
            }
        }
    }
    Ok(invalid.len())
}

fn receipt_matches(unit: &VectorReadinessRow, generation: &str, version: &str, key: &str) -> bool {
    let Some(raw) = unit.receipt_json.as_deref() else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return false;
    };
    value["generation"] == generation
        && value["embedding_version"] == version
        && value["vector_keys"]
            .as_array()
            .is_some_and(|keys| keys.iter().any(|item| item.as_str() == Some(key)))
}
fn source_refs_current(unit: &VectorReadinessRow, historical: &HashSet<String>) -> bool {
    let Some(raw) = unit.source_ids_json.as_deref() else {
        return false;
    };
    serde_json::from_str::<Vec<String>>(raw)
        .ok()
        .is_some_and(|refs| !refs.is_empty() && refs.iter().all(|id| historical.contains(id)))
}
fn metadata_matches(actual: &[Option<String>; 15], expected: &GenerationVectorRow) -> bool {
    let values = [
        &expected.vector_key,
        &expected.generation,
        &expected.record_kind,
        &expected.owner_id,
        &expected.owner_revision,
        &expected.source_revision,
        &expected.embedding_chunk_id,
        &expected.embedding_version,
        &expected.project_id,
        &expected.origin_kind,
        &expected.source_kind,
    ];
    values
        .iter()
        .enumerate()
        .all(|(index, wanted)| actual[index].as_deref() == Some(wanted.as_str()))
        && actual[11].as_deref() == expected.conversation_session_id.as_deref()
        && actual[12].as_deref() == Some(expected.source_observed_at.as_str())
        && actual[13].as_deref() == Some(expected.source_refs_json.as_str())
        && actual[14].as_deref() == Some("")
}
