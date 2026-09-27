//! Reuse a persisted node vector only when its stable identity and old membership agree.

use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
};

use arrow_array::{Array, FixedSizeListArray, Float32Array};
use chrono::{DateTime, SecondsFormat, Utc};
use futures_util::TryStreamExt;
use lancedb::query::{ExecutableQuery, QueryBase, Select};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use super::rows::{COLUMNS, GenerationVectorRow, optional_text, text};
use crate::cognition::CognitionCode;
use crate::cognition::{
    CognitionResult, MemoryGenerationHandle, ensure_data_authority, graph::VectorReadinessRow,
    lance_store,
};

const TABLE: &str = "butler_memory";

pub(crate) struct PreparedRepresentative {
    pub row: GenerationVectorRow,
    pub affected_unit_ids: Vec<String>,
}

/// Units of one vector key with their embedding chunk ids.
type Groups<'a> = BTreeMap<String, Vec<(&'a VectorReadinessRow, String)>>;

/// Finds node vectors whose stable identity is unchanged but whose source
/// membership moved from a superseded unit to current units, so the stored
/// vector can be reused with the current membership.
pub(crate) async fn prepare_representatives(
    data_root: &Path,
    generation: &MemoryGenerationHandle,
    current: &[VectorReadinessRow],
    superseded: &[VectorReadinessRow],
    cancellation: &CancellationToken,
) -> CognitionResult<Vec<PreparedRepresentative>> {
    if cancellation.is_cancelled() {
        return Err(aborted());
    }
    let Some(version) = generation
        .embedding
        .as_ref()
        .map(crate::cognition::GenerationEmbedding::version)
    else {
        return Ok(Vec::new());
    };
    let current_groups = group_units(current, generation, version);
    let superseded_groups = group_units(superseded, generation, version);
    let shared = current_groups
        .iter()
        .filter_map(|(key, units)| Some((key, units, superseded_groups.get(key)?)))
        .collect::<Vec<_>>();
    if shared.is_empty() {
        return Ok(Vec::new());
    }
    let root = generation.root.join("butler.lance");
    ensure_data_authority(
        data_root,
        &[&generation.root, &root, &root.join("butler_memory.lance")],
    )?;
    let Some(table) = open_table(&root).await else {
        return Ok(Vec::new());
    };
    let mut prepared = Vec::new();
    for (key, current_units, superseded_units) in shared {
        if cancellation.is_cancelled() {
            return Err(aborted());
        }
        let persisted = match unique_persisted_row(&table, key).await {
            Lookup::Unreadable => return Ok(Vec::new()),
            Lookup::NotUnique => continue,
            Lookup::Found(row) => *row,
        };
        let context = Representation {
            persisted: &persisted,
            generation,
            version,
        };
        if let Some(representative) = context.prepare(current_units, superseded_units) {
            prepared.push(representative);
        }
    }
    Ok(prepared)
}

fn group_units<'a>(
    units: &'a [VectorReadinessRow],
    generation: &MemoryGenerationHandle,
    version: &str,
) -> Groups<'a> {
    let mut groups: Groups<'a> = BTreeMap::new();
    for unit in units {
        if let Some((chunk, key)) = valid_identity(unit, generation, version) {
            groups.entry(key).or_default().push((unit, chunk));
        }
    }
    groups
}

async fn open_table(root: &Path) -> Option<lancedb::Table> {
    if !root.exists() {
        return None;
    }
    let connection = lance_store::connect(root).await.ok()?;
    lance_store::open(&connection, TABLE).await.ok()
}

/// The outcome of reading the stored row of one vector key.
enum Lookup {
    /// Lance or a row could not be read; nothing can be reused.
    Unreadable,
    /// Zero, several, or an unusable row: skip this key.
    NotUnique,
    /// Exactly one decodable row.
    Found(Box<GenerationVectorRow>),
}

/// A two-row limit establishes exact physical uniqueness without collecting
/// an unbounded corrupted table or masking a duplicate behind another key.
async fn unique_persisted_row(table: &lancedb::Table, key: &str) -> Lookup {
    let Ok(stream) = table
        .query()
        .only_if(format!("vector_key = '{key}'"))
        .select(Select::columns(&COLUMNS))
        .limit(2)
        .execute()
        .await
    else {
        return Lookup::Unreadable;
    };
    let Ok(batches) = stream.try_collect::<Vec<_>>().await else {
        return Lookup::Unreadable;
    };
    let mut physical = Vec::new();
    for batch in batches {
        for index in 0..batch.num_rows() {
            match decode(&batch, index) {
                Ok(row) => physical.push(row),
                Err(_) => return Lookup::Unreadable,
            }
        }
    }
    match physical.pop() {
        Some(Some(row)) if physical.is_empty() => Lookup::Found(Box::new(row)),
        _ => Lookup::NotUnique,
    }
}

/// One stored vector and the generation it could be reused in.
struct Representation<'a> {
    persisted: &'a GenerationVectorRow,
    generation: &'a MemoryGenerationHandle,
    version: &'a str,
}

impl Representation<'_> {
    fn stable(&self, unit: &VectorReadinessRow, chunk: &str) -> bool {
        stable_matches(self.persisted, self.generation, unit, chunk, self.version)
    }

    /// Reuses the stored vector for the current units when none of them
    /// already matches its membership but a superseded unit does.
    fn prepare(
        &self,
        current: &[(&VectorReadinessRow, String)],
        superseded: &[(&VectorReadinessRow, String)],
    ) -> Option<PreparedRepresentative> {
        let valid = current
            .iter()
            .filter(|(unit, chunk)| self.stable(unit, chunk))
            .map(|(unit, _)| *unit)
            .collect::<Vec<_>>();
        if valid.is_empty()
            || valid
                .iter()
                .any(|unit| membership_matches(self.persisted, unit))
        {
            return None;
        }
        let stale = superseded.iter().any(|(unit, chunk)| {
            self.stable(unit, chunk) && membership_matches(self.persisted, unit)
        });
        if !stale {
            return None;
        }
        let mut affected_unit_ids = valid
            .iter()
            .map(|unit| unit.unit_id.clone())
            .collect::<Vec<_>>();
        affected_unit_ids.sort();
        let representative = valid.iter().min_by(|a, b| a.unit_id.cmp(&b.unit_id))?;
        // stable_matches admitted only units with these source fields.
        let mut row = self.persisted.clone();
        row.source_revision = representative.source_revision.clone();
        row.source_kind = representative.source_kind.clone()?;
        row.conversation_session_id = representative.conversation_session_id.clone();
        row.source_observed_at = normalized_time(representative.source_observed_at.as_deref())?;
        row.source_refs_json = representative.source_ids_json.clone()?;
        Some(PreparedRepresentative {
            row,
            affected_unit_ids,
        })
    }
}

fn aborted() -> crate::cognition::CognitionError {
    crate::cognition::CognitionError::new(
        CognitionCode::MemoryOperationAborted,
        "memory_operation_aborted",
    )
}

/// The receipt fields a node vector's identity depends on.
#[derive(Deserialize)]
struct NodeVectorReceipt {
    #[serde(default, deserialize_with = "crate::lenient::option")]
    generation: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    embedding_version: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    vector_keys: Option<Vec<String>>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    row_count: Option<u64>,
}

/// The chunk id and vector key of a node unit whose receipt names exactly
/// its own vector keys.
fn valid_identity(
    unit: &VectorReadinessRow,
    generation: &MemoryGenerationHandle,
    version: &str,
) -> Option<(String, String)> {
    if unit.record_kind != "node"
        || unit.source_membership_invalid
        || unit.source_kind.is_none()
        || normalized_time(unit.source_observed_at.as_deref()).is_none()
    {
        return None;
    }
    let refs: Vec<String> = serde_json::from_str(unit.source_ids_json.as_deref()?).ok()?;
    if refs.is_empty() || refs.iter().any(String::is_empty) {
        return None;
    }
    let (chunk, key) = GenerationVectorRow::identity(
        &generation.generation_id,
        &unit.record_kind,
        &unit.owner_id,
        &unit.owner_revision,
        &unit.projection_text,
        version,
    );
    let receipt: NodeVectorReceipt = crate::lenient::object(unit.receipt_json.as_deref()?)?;
    let keys = receipt.vector_keys?;
    let unique = keys.iter().map(String::as_str).collect::<HashSet<_>>();
    if receipt.generation.as_deref() != Some(generation.generation_id.as_str())
        || receipt.embedding_version.as_deref() != Some(version)
        || keys.iter().any(String::is_empty)
        || usize::try_from(receipt.row_count?).unwrap_or(usize::MAX) != unique.len()
        || !unique.contains(key.as_str())
    {
        return None;
    }
    Some((chunk, key))
}

fn stable_matches(
    row: &GenerationVectorRow,
    generation: &MemoryGenerationHandle,
    unit: &VectorReadinessRow,
    chunk: &str,
    version: &str,
) -> bool {
    row.generation == generation.generation_id
        && row.record_kind == unit.record_kind
        && row.owner_id == unit.owner_id
        && row.owner_revision == unit.owner_revision
        && row.embedding_chunk_id == chunk
        && row.embedding_version == version
        && row.project_id == unit.project_id.as_deref().unwrap_or("")
        && row.origin_kind == unit.origin_kind
}

fn membership_matches(row: &GenerationVectorRow, unit: &VectorReadinessRow) -> bool {
    row.source_revision == unit.source_revision
        && Some(row.source_kind.as_str()) == unit.source_kind.as_deref()
        && row.conversation_session_id == unit.conversation_session_id
        && Some(row.source_observed_at.as_str())
            == normalized_time(unit.source_observed_at.as_deref()).as_deref()
        && Some(row.source_refs_json.as_str()) == unit.source_ids_json.as_deref()
}

fn normalized_time(raw: Option<&str>) -> Option<String> {
    let time = DateTime::parse_from_rfc3339(raw?).ok()?;
    Some(
        time.with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true),
    )
}

fn decode(
    batch: &arrow_array::RecordBatch,
    index: usize,
) -> CognitionResult<Option<GenerationVectorRow>> {
    let Some(vector) = batch
        .column(15)
        .as_any()
        .downcast_ref::<FixedSizeListArray>()
    else {
        return Ok(None);
    };
    let values = vector.value(index);
    let Some(values) = values.as_any().downcast_ref::<Float32Array>() else {
        return Ok(None);
    };
    if values.len() != 1024
        || values.null_count() != 0
        || values.values().iter().any(|value| !value.is_finite())
    {
        return Ok(None);
    }
    Ok(Some(GenerationVectorRow {
        vector_key: text(batch, 0, index)?,
        generation: text(batch, 1, index)?,
        record_kind: text(batch, 2, index)?,
        owner_id: text(batch, 3, index)?,
        owner_revision: text(batch, 4, index)?,
        source_revision: text(batch, 5, index)?,
        embedding_chunk_id: text(batch, 6, index)?,
        embedding_version: text(batch, 7, index)?,
        project_id: text(batch, 8, index)?,
        origin_kind: text(batch, 9, index)?,
        source_kind: text(batch, 10, index)?,
        conversation_session_id: optional_text(batch, 11, index)?,
        source_observed_at: text(batch, 12, index)?,
        source_refs_json: text(batch, 13, index)?,
        vector: values.values().to_vec(),
    }))
}
