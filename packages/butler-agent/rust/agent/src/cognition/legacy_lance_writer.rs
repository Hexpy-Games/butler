//! Source-compatible legacy memory vectors, never the active generation store.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use arrow_array::{
    ArrayRef, FixedSizeListArray, Float64Array, RecordBatch, StringArray, types::Float32Type,
};
use arrow_schema::{DataType, Field, Schema, SchemaRef};

use super::{
    CognitionError, CognitionPathEnvironment, CognitionResult, ensure_data_authority, lance_store,
};
use crate::coordination::CognitionWriteLease;

const TABLE: &str = "butler_memory";
const VECTOR_DIMENSION: usize = 1024;

pub(crate) struct LegacyVectorRow {
    pub(crate) id: String,
    pub(crate) text: String,
    pub(crate) project: String,
    pub(crate) r#type: String,
    pub(crate) session_id: String,
    pub(crate) timestamp: f64,
    pub(crate) hot_score: f64,
    pub(crate) source: String,
    pub(crate) topic: String,
    pub(crate) vector: Vec<f32>,
}

pub(crate) struct LegacyLanceWriter {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
}

impl LegacyLanceWriter {
    pub(crate) fn new(data_root: PathBuf, paths: CognitionPathEnvironment) -> Self {
        Self { data_root, paths }
    }

    /// The caller retains the Cognition write lease through this awaited
    /// delete/add/count sequence and any subsequent graph/metadata commit.
    pub(crate) fn upsert_session<'a>(
        &'a self,
        lease: &CognitionWriteLease,
        session_id: &'a str,
        rows: &'a [LegacyVectorRow],
    ) -> impl std::future::Future<Output = CognitionResult<usize>> + Send + 'a {
        let lease_check = lease
            .assert_for_path(&self.paths.consolidation_lock(&self.data_root))
            .map_err(|_| error("memory_write_busy"));
        async move {
            lease_check?;
            validate_rows(session_id, rows)?;
            let memory_root = self.paths.memory_root(&self.data_root);
            let db_root = memory_root.join("db");
            let lance_root = db_root.join("butler.lance");
            let table_root = lance_root.join("butler_memory.lance");
            ensure_data_authority(
                &self.data_root,
                &[&memory_root, &db_root, &lance_root, &table_root],
            )?;
            guard_lance_write_paths(&self.data_root, &table_root)?;
            let expected_schema = legacy_schema();
            let batch = record_batch(rows, &expected_schema)?;

            // The connect may create the database directory. It is deliberately
            // below both DATA authority and the held write gate.
            let connection = lance_store::connect(&lance_root)
                .await
                .map_err(|_| error("legacy_vector_store_unavailable"))?;
            let table = match lance_store::open(&connection, TABLE).await {
                Ok(table) => table,
                Err(lancedb::Error::TableNotFound { .. }) => connection
                    .create_empty_table(TABLE, expected_schema.clone())
                    .execute()
                    .await
                    .map_err(|_| error("legacy_vector_store_unavailable"))?,
                Err(_) => return Err(error("legacy_vector_store_unavailable")),
            };
            let actual_schema = table
                .schema()
                .await
                .map_err(|_| error("legacy_vector_store_unavailable"))?;
            if !same_columns(&actual_schema, &expected_schema) {
                return Err(error("legacy_vector_schema_mismatch"));
            }
            let predicate = format!("session_id = '{session_id}'");
            table
                .delete(&predicate)
                .await
                .map_err(|_| error("legacy_vector_store_unavailable"))?;
            table
                .add(batch)
                .execute()
                .await
                .map_err(|_| error("legacy_vector_store_unavailable"))?;
            table
                .count_rows(None)
                .await
                .map_err(|_| error("legacy_vector_store_unavailable"))
        }
    }
}

fn validate_rows(session_id: &str, rows: &[LegacyVectorRow]) -> CognitionResult<()> {
    if session_id.is_empty()
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        || rows.is_empty()
    {
        return Err(error("legacy_vector_invalid_rows"));
    }
    for (index, row) in rows.iter().enumerate() {
        if row.session_id != session_id
            || row.id != format!("{session_id}_{index}")
            || !row.timestamp.is_finite()
            || !row.hot_score.is_finite()
            || row.vector.len() != VECTOR_DIMENSION
            || row.vector.iter().any(|value| !value.is_finite())
        {
            return Err(error("legacy_vector_invalid_rows"));
        }
    }
    Ok(())
}

fn legacy_schema() -> SchemaRef {
    Arc::new(Schema::new(vec![
        Field::new("id", DataType::Utf8, true),
        Field::new("text", DataType::Utf8, true),
        Field::new("project", DataType::Utf8, true),
        Field::new("type", DataType::Utf8, true),
        Field::new("session_id", DataType::Utf8, true),
        Field::new("timestamp", DataType::Float64, true),
        Field::new("hot_score", DataType::Float64, true),
        Field::new("source", DataType::Utf8, true),
        Field::new("topic", DataType::Utf8, true),
        Field::new(
            "vector",
            DataType::FixedSizeList(
                Arc::new(Field::new("item", DataType::Float32, true)),
                i32::try_from(VECTOR_DIMENSION).unwrap_or(i32::MAX),
            ),
            true,
        ),
    ]))
}

fn same_columns(actual: &SchemaRef, expected: &SchemaRef) -> bool {
    actual.fields().len() == expected.fields().len()
        && actual.fields().iter().zip(expected.fields()).all(|(a, b)| {
            a.name() == b.name()
                && a.data_type() == b.data_type()
                && a.is_nullable() == b.is_nullable()
        })
}

fn record_batch(rows: &[LegacyVectorRow], schema: &SchemaRef) -> CognitionResult<RecordBatch> {
    let strings = |field: fn(&LegacyVectorRow) -> &str| -> ArrayRef {
        Arc::new(StringArray::from_iter_values(rows.iter().map(field)))
    };
    let vectors = FixedSizeListArray::from_iter_primitive::<Float32Type, _, _>(
        rows.iter()
            .map(|row| Some(row.vector.iter().copied().map(Some).collect::<Vec<_>>())),
        i32::try_from(VECTOR_DIMENSION).unwrap_or(i32::MAX),
    );
    let arrays: Vec<ArrayRef> = vec![
        strings(|row| &row.id),
        strings(|row| &row.text),
        strings(|row| &row.project),
        strings(|row| &row.r#type),
        strings(|row| &row.session_id),
        Arc::new(Float64Array::from_iter_values(
            rows.iter().map(|row| row.timestamp),
        )),
        Arc::new(Float64Array::from_iter_values(
            rows.iter().map(|row| row.hot_score),
        )),
        strings(|row| &row.source),
        strings(|row| &row.topic),
        Arc::new(vectors),
    ];
    RecordBatch::try_new(schema.clone(), arrays).map_err(|_| error("legacy_vector_invalid_rows"))
}

fn guard_lance_write_paths(data_root: &Path, table_root: &Path) -> CognitionResult<()> {
    // Lance 0.27.2 writes data fragments and version/transaction metadata in
    // these table-owned directories. Check each at every operation without
    // recursively scanning existing data files for every hot-cache block.
    let writable = [
        table_root.to_path_buf(),
        table_root.join("data"),
        table_root.join("_versions"),
        table_root.join("_transactions"),
        table_root.join("_indices"),
        table_root.join("_deletions"),
    ];
    let paths = writable.iter().map(PathBuf::as_path).collect::<Vec<_>>();
    ensure_data_authority(data_root, &paths)?;
    for path in &writable {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(error("memory_data_path_unsafe"));
            }
            Ok(_) => {}
            Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(error("memory_data_path_unsafe")),
        }
    }
    Ok(())
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
