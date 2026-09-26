use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use arrow_array::{
    Array, ArrayRef, FixedSizeListArray, RecordBatch, StringArray, types::Float32Type,
};
use arrow_schema::{DataType, Field, Schema, SchemaRef};
use futures_util::TryStreamExt;
use lancedb::{
    Table,
    query::{ExecutableQuery, QueryBase, Select},
};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult, MemoryGenerationHandle,
        MemoryGenerationTarget, assert_mutation_authority, ensure_data_authority, lance_store,
    },
    coordination::CognitionWriteLease,
};

const TABLE: &str = "butler_memory";
const DIMENSION: usize = 1024;

#[derive(Clone)]
pub(crate) struct GenerationVectorRow {
    pub vector_key: String,
    pub generation: String,
    pub record_kind: String,
    pub owner_id: String,
    pub owner_revision: String,
    pub source_revision: String,
    pub embedding_chunk_id: String,
    pub embedding_version: String,
    pub project_id: String,
    pub origin_kind: String,
    pub source_kind: String,
    pub conversation_session_id: Option<String>,
    pub source_observed_at: String,
    pub source_refs_json: String,
    pub vector: Vec<f32>,
}

impl GenerationVectorRow {
    pub(crate) fn identity(
        generation: &str,
        kind: &str,
        owner: &str,
        revision: &str,
        text: &str,
        version: &str,
    ) -> (String, String) {
        let chunk = digest(&json!(["embedding-chunk", revision, 0, text]));
        let key = digest(&json!([
            "memory-vector",
            generation,
            kind,
            owner,
            revision,
            chunk,
            version
        ]));
        (chunk, key)
    }
}

fn digest(value: &serde_json::Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

pub(crate) struct NativeGenerationVectorStore {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
}

impl NativeGenerationVectorStore {
    pub(crate) fn new(data_root: PathBuf, paths: CognitionPathEnvironment) -> Self {
        Self { data_root, paths }
    }

    /// Caller retains the write lease until the SDK mutation and receipt query finish.
    pub(crate) fn upsert<'a>(
        &'a self,
        lease: &CognitionWriteLease,
        target: &'a MemoryGenerationTarget,
        generation: &'a MemoryGenerationHandle,
        rows: &'a [GenerationVectorRow],
    ) -> impl Future<Output = CognitionResult<String>> + Send + 'a {
        let lock = self.paths.consolidation_lock(&self.data_root);
        let lease_check = lease
            .assert_for_path(&lock)
            .map_err(|_| error("memory_write_busy"));
        async move {
            lease_check?;
            if rows.is_empty()
                || rows.len() > 4
                || rows.iter().any(|row| {
                    row.generation != generation.generation_id
                        || row.vector.len() != DIMENSION
                        || row.vector.iter().any(|value| !value.is_finite())
                        || row.vector_key.len() != 64
                        || row.embedding_chunk_id.len() != 64
                })
            {
                return Err(error("memory_vector_rows_invalid"));
            }
            assert_mutation_authority(&self.data_root, &self.paths, target, generation)?;
            let root = generation.root.join("butler.lance");
            let table_root = root.join("butler_memory.lance");
            ensure_data_authority(
                &self.data_root,
                &[
                    &generation.root,
                    &root,
                    &table_root,
                    &table_root.join("data"),
                    &table_root.join("_versions"),
                    &table_root.join("_transactions"),
                    &table_root.join("_indices"),
                    &table_root.join("_deletions"),
                ],
            )?;
            let connection = lance_store::connect(&root)
                .await
                .map_err(|_| error("memory_vector_store_unavailable"))?;
            let schema = schema();
            let table = match lance_store::open(&connection, TABLE).await {
                Ok(table) => table,
                Err(lancedb::Error::TableNotFound { .. }) => connection
                    .create_empty_table(TABLE, schema.clone())
                    .execute()
                    .await
                    .map_err(|_| error("memory_vector_store_unavailable"))?,
                Err(_) => return Err(error("memory_vector_store_unavailable")),
            };
            check_schema(&table, &schema).await?;
            let predicate = format!(
                "vector_key IN ({})",
                rows.iter()
                    .map(|row| format!("'{}'", row.vector_key))
                    .collect::<Vec<_>>()
                    .join(",")
            );
            // Started SDK writes are awaited to completion while the caller holds the lease.
            table
                .delete(&predicate)
                .await
                .map_err(|_| error("memory_vector_store_unavailable"))?;
            table
                .add(batch(rows, schema)?)
                .execute()
                .await
                .map_err(|_| error("memory_vector_store_unavailable"))?;
            let receipt = persisted_receipt_in_table(&table, generation, rows)
                .await?
                .ok_or_else(|| error("memory_vector_receipt_mismatch"))?;
            Ok(receipt)
        }
    }
}

pub(crate) async fn persisted_receipt(
    data_root: &Path,
    generation: &MemoryGenerationHandle,
    rows: &[GenerationVectorRow],
) -> CognitionResult<Option<String>> {
    if rows.is_empty() {
        return Ok(None);
    }
    let root = generation.root.join("butler.lance");
    ensure_data_authority(
        data_root,
        &[&generation.root, &root, &root.join("butler_memory.lance")],
    )?;
    if !root.exists() {
        return Ok(None);
    }
    let connection = lance_store::connect(&root)
        .await
        .map_err(|_| error("memory_vector_store_unavailable"))?;
    let table = match lance_store::open(&connection, TABLE).await {
        Ok(table) => table,
        Err(lancedb::Error::TableNotFound { .. }) => return Ok(None),
        Err(_) => return Err(error("memory_vector_store_unavailable")),
    };
    persisted_receipt_in_table(&table, generation, rows).await
}

async fn persisted_receipt_in_table(
    table: &Table,
    generation: &MemoryGenerationHandle,
    rows: &[GenerationVectorRow],
) -> CognitionResult<Option<String>> {
    let predicate = format!(
        "vector_key IN ({})",
        rows.iter()
            .map(|row| format!("'{}'", row.vector_key))
            .collect::<Vec<_>>()
            .join(",")
    );
    let batches = table
        .query()
        .only_if(predicate)
        .select(Select::columns(&COLUMNS[..15]))
        .limit(rows.len() + 1)
        .execute()
        .await
        .map_err(|_| error("memory_vector_store_unavailable"))?
        .try_collect::<Vec<_>>()
        .await
        .map_err(|_| error("memory_vector_store_unavailable"))?;
    let mut seen = Vec::new();
    for batch in batches {
        for index in 0..batch.num_rows() {
            let key = text(&batch, 0, index)?;
            let Some(wanted) = rows.iter().find(|row| row.vector_key == key) else {
                return Ok(None);
            };
            let expected = [
                wanted.vector_key.as_str(),
                wanted.generation.as_str(),
                wanted.record_kind.as_str(),
                wanted.owner_id.as_str(),
                wanted.owner_revision.as_str(),
                wanted.source_revision.as_str(),
                wanted.embedding_chunk_id.as_str(),
                wanted.embedding_version.as_str(),
                wanted.project_id.as_str(),
                wanted.origin_kind.as_str(),
                wanted.source_kind.as_str(),
            ];
            if expected
                .iter()
                .enumerate()
                .any(|(column, value)| text(&batch, column, index).ok().as_deref() != Some(*value))
                || optional_text(&batch, 11, index)? != wanted.conversation_session_id
                || text(&batch, 12, index)? != wanted.source_observed_at
                || text(&batch, 13, index)? != wanted.source_refs_json
                || !text(&batch, 14, index)?.is_empty()
            {
                return Ok(None);
            }
            seen.push(key);
        }
    }
    if seen.len() != rows.len() || rows.iter().any(|row| !seen.contains(&row.vector_key)) {
        return Ok(None);
    }
    seen.sort();
    let version = &rows[0].embedding_version;
    if rows.iter().any(|row| row.embedding_version != *version) {
        return Ok(None);
    }
    Ok(Some(
        json!({"generation":generation.generation_id,"embedding_version":version,
        "vector_keys":seen,"row_count":rows.len()})
        .to_string(),
    ))
}

pub(super) const COLUMNS: [&str; 16] = [
    "vector_key",
    "generation",
    "record_kind",
    "owner_id",
    "owner_revision",
    "source_revision",
    "embedding_chunk_id",
    "embedding_version",
    "project_id",
    "origin_kind",
    "source_kind",
    "conversation_session_id",
    "source_observed_at",
    "source_refs_json",
    "text",
    "vector",
];

fn schema() -> SchemaRef {
    let mut fields = COLUMNS[..15]
        .iter()
        .map(|name| Field::new(*name, DataType::Utf8, *name == "conversation_session_id"))
        .collect::<Vec<_>>();
    fields.push(Field::new(
        "vector",
        DataType::FixedSizeList(
            Arc::new(Field::new("item", DataType::Float32, true)),
            DIMENSION as i32,
        ),
        false,
    ));
    Arc::new(Schema::new(fields))
}

async fn check_schema(table: &Table, expected: &SchemaRef) -> CognitionResult<()> {
    let actual = table
        .schema()
        .await
        .map_err(|_| error("memory_vector_store_unavailable"))?;
    if actual.fields().len() != expected.fields().len()
        || actual.fields().iter().zip(expected.fields()).any(|(a, b)| {
            a.name() != b.name()
                || a.data_type() != b.data_type()
                || a.is_nullable() != b.is_nullable()
        })
    {
        return Err(error("memory_vector_schema_mismatch"));
    }
    Ok(())
}

fn batch(rows: &[GenerationVectorRow], schema: SchemaRef) -> CognitionResult<RecordBatch> {
    let strings = |f: fn(&GenerationVectorRow) -> &str| -> ArrayRef {
        Arc::new(StringArray::from_iter_values(rows.iter().map(f)))
    };
    let arrays: Vec<ArrayRef> = vec![
        strings(|r| &r.vector_key),
        strings(|r| &r.generation),
        strings(|r| &r.record_kind),
        strings(|r| &r.owner_id),
        strings(|r| &r.owner_revision),
        strings(|r| &r.source_revision),
        strings(|r| &r.embedding_chunk_id),
        strings(|r| &r.embedding_version),
        strings(|r| &r.project_id),
        strings(|r| &r.origin_kind),
        strings(|r| &r.source_kind),
        Arc::new(StringArray::from(
            rows.iter()
                .map(|r| r.conversation_session_id.as_deref())
                .collect::<Vec<_>>(),
        )),
        strings(|r| &r.source_observed_at),
        strings(|r| &r.source_refs_json),
        Arc::new(StringArray::from_iter_values(rows.iter().map(|_| ""))),
        Arc::new(
            FixedSizeListArray::from_iter_primitive::<Float32Type, _, _>(
                rows.iter()
                    .map(|r| Some(r.vector.iter().copied().map(Some).collect::<Vec<_>>())),
                DIMENSION as i32,
            ),
        ),
    ];
    RecordBatch::try_new(schema, arrays).map_err(|_| error("memory_vector_rows_invalid"))
}

pub(super) fn text(batch: &RecordBatch, column: usize, row: usize) -> CognitionResult<String> {
    optional_text(batch, column, row)?.ok_or_else(|| error("memory_vector_rows_invalid"))
}
pub(super) fn optional_text(
    batch: &RecordBatch,
    column: usize,
    row: usize,
) -> CognitionResult<Option<String>> {
    let strings = batch
        .column(column)
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or_else(|| error("memory_vector_rows_invalid"))?;
    Ok((!strings.is_null(row)).then(|| strings.value(row).to_owned()))
}
pub(super) fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
