//! Read-only physical witness for complete rebuild vector units.
//!
//! Every complete vector unit must have a receipt naming its vector key and a
//! Lance row whose metadata matches the unit exactly. Any Lance failure counts
//! every unit as invalid.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use chrono::{DateTime, SecondsFormat, Utc};
use futures_util::TryStreamExt;
use lancedb::{
    Table,
    query::{ExecutableQuery, QueryBase, Select},
};
use serde::Deserialize;

use super::rows::{COLUMNS, GenerationVectorRow, optional_text, text};
use crate::cognition::{
    CognitionResult, MemoryGenerationHandle, ensure_data_authority, graph::VectorReadinessRow,
    lance_store,
};

const CHUNK: usize = 100;
/// Metadata columns compared against a unit (every column but the vector).
const METADATA_COLUMNS: usize = 15;

/// The row a group of units expects, and the units that share it.
struct Expected {
    row: GenerationVectorRow,
    units: Vec<usize>,
}

/// The metadata columns of one stored Lance row.
type PhysicalRow = [Option<String>; METADATA_COLUMNS];

/// Counts complete rebuild vector units whose receipt, sources, or stored
/// Lance row no longer match.
pub(crate) async fn invalid_persisted_rebuild_vectors(
    data_root: &Path,
    generation: &MemoryGenerationHandle,
    units: &[VectorReadinessRow],
    historical: &HashSet<String>,
) -> CognitionResult<usize> {
    if units.is_empty() {
        return Ok(0);
    }
    let Some(version) = generation
        .embedding
        .as_ref()
        .map(crate::cognition::GenerationEmbedding::version)
    else {
        return Ok(units.len());
    };
    let root = generation.root.join("butler.lance");
    ensure_data_authority(
        data_root,
        &[&generation.root, &root, &root.join("butler_memory.lance")],
    )?;
    let (mut invalid, groups) = expectations(generation, version, units, historical);
    let Some(table) = open_table(&root).await else {
        return Ok(units.len());
    };
    let keys = groups.keys().cloned().collect::<Vec<_>>();
    for chunk in keys.chunks(CHUNK) {
        let Some(seen) = physical_rows(&table, chunk).await? else {
            return Ok(units.len());
        };
        for key in chunk {
            let Some(expectations) = groups.get(key) else {
                continue;
            };
            let matches = seen.get(key).is_some_and(|rows| match rows.as_slice() {
                [row] => expectations
                    .iter()
                    .any(|expected| metadata_matches(row, &expected.row)),
                _ => false,
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

/// The expected row of every unit, grouped by vector key, and the units
/// already invalid from their graph facts alone.
fn expectations(
    generation: &MemoryGenerationHandle,
    version: &str,
    units: &[VectorReadinessRow],
    historical: &HashSet<String>,
) -> (HashSet<usize>, HashMap<String, Vec<Expected>>) {
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
        let observed = unit
            .source_observed_at
            .as_ref()
            .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok());
        let (Some(source_kind), Some(observed), Some(refs)) = (
            unit.source_kind.as_ref(),
            observed,
            unit.source_ids_json.as_ref(),
        ) else {
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
    (invalid, groups)
}

async fn open_table(root: &Path) -> Option<Table> {
    if !root.exists() {
        return None;
    }
    let connection = lance_store::connect(root).await.ok()?;
    lance_store::open(&connection, "butler_memory").await.ok()
}

/// The stored metadata rows for `keys`, or `None` when Lance cannot answer.
async fn physical_rows(
    table: &Table,
    keys: &[String],
) -> CognitionResult<Option<HashMap<String, Vec<PhysicalRow>>>> {
    let predicate = format!(
        "vector_key IN ({})",
        keys.iter()
            .map(|key| format!("'{key}'"))
            .collect::<Vec<_>>()
            .join(",")
    );
    let columns = COLUMNS.get(..METADATA_COLUMNS).unwrap_or(&COLUMNS);
    let Ok(stream) = table
        .query()
        .only_if(predicate)
        .select(Select::columns(columns))
        .limit(keys.len() + 1)
        .execute()
        .await
    else {
        return Ok(None);
    };
    let Ok(batches) = stream.try_collect::<Vec<_>>().await else {
        return Ok(None);
    };
    let mut seen: HashMap<String, Vec<PhysicalRow>> = HashMap::new();
    for batch in batches {
        for index in 0..batch.num_rows() {
            let key = text(&batch, 0, index)?;
            let mut values: PhysicalRow = std::array::from_fn(|_| None);
            for (column, value) in values.iter_mut().enumerate() {
                *value = optional_text(&batch, column, index)?;
            }
            seen.entry(key).or_default().push(values);
        }
    }
    Ok(Some(seen))
}

/// The receipt fields a vector unit's currentness depends on.
#[derive(Deserialize)]
struct VectorReceipt {
    #[serde(default, deserialize_with = "crate::lenient::option")]
    generation: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    embedding_version: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::strings")]
    vector_keys: Option<Vec<String>>,
}

fn receipt_matches(unit: &VectorReadinessRow, generation: &str, version: &str, key: &str) -> bool {
    let Some(receipt) = unit
        .receipt_json
        .as_deref()
        .and_then(crate::lenient::object::<VectorReceipt>)
    else {
        return false;
    };
    receipt.generation.as_deref() == Some(generation)
        && receipt.embedding_version.as_deref() == Some(version)
        && receipt
            .vector_keys
            .is_some_and(|keys| keys.iter().any(|item| item == key))
}

fn source_refs_current(unit: &VectorReadinessRow, historical: &HashSet<String>) -> bool {
    let Some(raw) = unit.source_ids_json.as_deref() else {
        return false;
    };
    serde_json::from_str::<Vec<String>>(raw)
        .ok()
        .is_some_and(|refs| !refs.is_empty() && refs.iter().all(|id| historical.contains(id)))
}

fn metadata_matches(actual: &PhysicalRow, expected: &GenerationVectorRow) -> bool {
    let wanted = [
        Some(expected.vector_key.as_str()),
        Some(expected.generation.as_str()),
        Some(expected.record_kind.as_str()),
        Some(expected.owner_id.as_str()),
        Some(expected.owner_revision.as_str()),
        Some(expected.source_revision.as_str()),
        Some(expected.embedding_chunk_id.as_str()),
        Some(expected.embedding_version.as_str()),
        Some(expected.project_id.as_str()),
        Some(expected.origin_kind.as_str()),
        Some(expected.source_kind.as_str()),
        expected.conversation_session_id.as_deref(),
        Some(expected.source_observed_at.as_str()),
        Some(expected.source_refs_json.as_str()),
        Some(""),
    ];
    actual
        .iter()
        .zip(wanted)
        .all(|(actual, wanted)| actual.as_deref() == wanted)
}
