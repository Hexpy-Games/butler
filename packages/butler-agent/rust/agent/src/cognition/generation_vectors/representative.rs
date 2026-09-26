//! Reuse a persisted node vector only when its stable identity and old membership agree.

use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
};

use arrow_array::{Array, FixedSizeListArray, Float32Array};
use chrono::{DateTime, SecondsFormat, Utc};
use futures_util::TryStreamExt;
use lancedb::{
    Error as LanceError,
    query::{ExecutableQuery, QueryBase, Select},
};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::rows::{COLUMNS, GenerationVectorRow, optional_text, text};
use crate::cognition::{
    CognitionResult, MemoryGenerationHandle, ensure_data_authority, graph::VectorReadinessRow,
    lance_store,
};

const TABLE: &str = "butler_memory";

pub(crate) struct PreparedRepresentative {
    pub row: GenerationVectorRow,
    pub affected_unit_ids: Vec<String>,
}

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
        .map(|embedding| embedding.version())
    else {
        return Ok(Vec::new());
    };
    let mut current_groups: BTreeMap<String, Vec<(&VectorReadinessRow, String)>> = BTreeMap::new();
    let mut superseded_groups: BTreeMap<String, Vec<(&VectorReadinessRow, String)>> =
        BTreeMap::new();
    for unit in current {
        if let Some((chunk, key)) = valid_identity(unit, generation, version) {
            current_groups.entry(key).or_default().push((unit, chunk));
        }
    }
    for unit in superseded {
        if let Some((chunk, key)) = valid_identity(unit, generation, version) {
            superseded_groups
                .entry(key)
                .or_default()
                .push((unit, chunk));
        }
    }
    let keys = current_groups
        .keys()
        .filter(|key| superseded_groups.contains_key(*key))
        .cloned()
        .collect::<Vec<_>>();
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let root = generation.root.join("butler.lance");
    ensure_data_authority(
        data_root,
        &[&generation.root, &root, &root.join("butler_memory.lance")],
    )?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let connection = match lance_store::connect(&root).await {
        Ok(connection) => connection,
        Err(_) => return Ok(Vec::new()),
    };
    let table = match lance_store::open(&connection, TABLE).await {
        Ok(table) => table,
        Err(LanceError::TableNotFound { .. }) => return Ok(Vec::new()),
        Err(_) => return Ok(Vec::new()),
    };
    let mut prepared = Vec::new();
    for key in &keys {
        if cancellation.is_cancelled() {
            return Err(aborted());
        }
        // A two-row limit establishes exact physical uniqueness without collecting
        // an unbounded corrupted table or masking a duplicate behind another key.
        let predicate = format!("vector_key = '{key}'");
        let batches = match table
            .query()
            .only_if(predicate)
            .select(Select::columns(&COLUMNS))
            .limit(2)
            .execute()
            .await
        {
            Ok(stream) => match stream.try_collect::<Vec<_>>().await {
                Ok(batches) => batches,
                Err(_) => return Ok(Vec::new()),
            },
            Err(_) => return Ok(Vec::new()),
        };
        let mut physical = Vec::new();
        for batch in batches {
            for index in 0..batch.num_rows() {
                match decode(&batch, index) {
                    Ok(row) => physical.push(row),
                    Err(_) => return Ok(Vec::new()),
                }
            }
        }
        let Some(Some(persisted)) = physical.first().filter(|_| physical.len() == 1) else {
            continue;
        };
        let candidates = &current_groups[key];
        let valid = candidates
            .iter()
            .filter(|(unit, chunk)| stable_matches(persisted, generation, unit, chunk, version))
            .collect::<Vec<_>>();
        if valid.is_empty()
            || valid
                .iter()
                .any(|(unit, _)| membership_matches(persisted, unit))
        {
            continue;
        }
        let stale = superseded_groups[key].iter().any(|(unit, chunk)| {
            stable_matches(persisted, generation, unit, chunk, version)
                && membership_matches(persisted, unit)
        });
        if !stale {
            continue;
        }
        let mut affected_unit_ids = valid
            .iter()
            .map(|(unit, _)| unit.unit_id.clone())
            .collect::<Vec<_>>();
        affected_unit_ids.sort();
        let representative = valid
            .iter()
            .min_by(|(a, _), (b, _)| a.unit_id.cmp(&b.unit_id))
            .unwrap()
            .0;
        let mut row = persisted.clone();
        row.source_revision = representative.source_revision.clone();
        row.source_kind = representative.source_kind.clone().unwrap();
        row.conversation_session_id = representative.conversation_session_id.clone();
        row.source_observed_at =
            normalized_time(representative.source_observed_at.as_deref()).unwrap();
        row.source_refs_json = representative.source_ids_json.clone().unwrap();
        prepared.push(PreparedRepresentative {
            row,
            affected_unit_ids,
        });
    }
    Ok(prepared)
}

fn aborted() -> crate::cognition::CognitionError {
    crate::cognition::CognitionError::new("memory_operation_aborted", "memory_operation_aborted")
}

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
    let receipt: Value = serde_json::from_str(unit.receipt_json.as_deref()?).ok()?;
    let keys = receipt["vector_keys"].as_array()?;
    let unique = keys
        .iter()
        .map(|item| item.as_str())
        .collect::<Option<HashSet<_>>>()?;
    if receipt["generation"] != generation.generation_id
        || receipt["embedding_version"] != version
        || keys
            .iter()
            .any(|item| item.as_str().is_none_or(str::is_empty))
        || receipt["row_count"].as_u64()? as usize != unique.len()
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
