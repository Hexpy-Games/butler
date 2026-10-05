//! Copies surviving vectors without inference, preserving their complete payloads.
use arrow_array::{Array, RecordBatch, RecordBatchIterator, RecordBatchReader, StringArray};
use futures_util::TryStreamExt;
use lancedb::{
    Table,
    query::{ExecutableQuery, QueryBase},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, io, path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(super) async fn copy(
    old: &Path,
    new: &Path,
    graph: &Path,
    generation: &str,
    token: &CancellationToken,
) -> io::Result<()> {
    let keys = load_keys(graph).await?;
    if keys.is_empty() {
        return Ok(());
    }
    let source = super::super::super::lance_store::connect(&old.join("butler.lance"))
        .await
        .map_err(io::Error::other)?;
    let table = super::super::super::lance_store::open(&source, "butler_memory")
        .await
        .map_err(io::Error::other)?;
    let target = super::super::super::lance_store::connect(&new.join("butler.lance"))
        .await
        .map_err(io::Error::other)?;
    let mut destination: Option<Table> = None;
    let mut replacements = HashMap::new();
    for group in keys.chunks(256) {
        check(token)?;
        let predicate = format!(
            "vector_key IN ({})",
            group
                .iter()
                .map(|key| format!("'{}'", key.replace('\'', "''")))
                .collect::<Vec<_>>()
                .join(",")
        );
        let mut stream = table
            .query()
            .only_if(predicate)
            .execute()
            .await
            .map_err(io::Error::other)?;
        while let Some(batch) = stream.try_next().await.map_err(io::Error::other)? {
            check(token)?;
            let batch = rekey(&batch, generation, &mut replacements)?;
            let rows = RecordBatchIterator::new(vec![Ok(batch.clone())], batch.schema());
            match &destination {
                Some(table) => {
                    table
                        .add(Box::new(rows) as Box<dyn RecordBatchReader + Send>)
                        .execute()
                        .await
                        .map_err(io::Error::other)?;
                }
                None => {
                    destination = Some(
                        target
                            .create_table(
                                "butler_memory",
                                Box::new(rows) as Box<dyn RecordBatchReader + Send>,
                            )
                            .execute()
                            .await
                            .map_err(io::Error::other)?,
                    );
                }
            }
        }
    }
    if replacements.len() != keys.len() || keys.iter().any(|key| !replacements.contains_key(key)) {
        return Err(io::Error::other("Typed vector survivor copy is incomplete"));
    }
    rewrite(graph, generation, replacements).await
}

async fn load_keys(graph: &Path) -> io::Result<Vec<String>> {
    let graph_path = graph.to_owned();
    tokio::task::spawn_blocking(move || {
        let db = butler_platform::sqlite::open_with_flags(
            graph_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(io::Error::other)?;
        surviving_keys(&db)
    })
    .await
    .map_err(io::Error::other)?
}

async fn rewrite(
    graph: &Path,
    generation: &str,
    replacements: HashMap<String, String>,
) -> io::Result<()> {
    let graph_path = graph.to_owned();
    let generation = generation.to_owned();
    tokio::task::spawn_blocking(move || {
        let db = butler_platform::sqlite::open(graph_path).map_err(io::Error::other)?;
        rewrite_receipts(&db, &generation, &replacements)
    })
    .await
    .map_err(io::Error::other)?
}

fn surviving_keys(db: &Connection) -> io::Result<Vec<String>> {
    let mut query = db.prepare("SELECT DISTINCT k.value FROM memory_vector_units u, json_each(json_extract(u.receipt_json,'$.vector_keys')) k WHERE u.state='complete' ORDER BY k.value").map_err(io::Error::other)?;
    query
        .query_map([], |row| row.get(0))
        .map_err(io::Error::other)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io::Error::other)
}

fn text<'a>(batch: &'a RecordBatch, name: &str, row: usize) -> io::Result<&'a str> {
    let index = batch.schema().index_of(name).map_err(io::Error::other)?;
    let column = batch
        .column(index)
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or_else(|| io::Error::other("Unsupported vector schema"))?;
    if column.is_null(row) {
        return Err(io::Error::other("Incomplete vector metadata"));
    }
    Ok(column.value(row))
}

fn rekey(
    batch: &RecordBatch,
    generation: &str,
    replacements: &mut HashMap<String, String>,
) -> io::Result<RecordBatch> {
    let mut keys = Vec::with_capacity(batch.num_rows());
    for row in 0..batch.num_rows() {
        let key = format!(
            "{:x}",
            Sha256::digest(
                json!([
                    "memory-vector",
                    generation,
                    text(batch, "record_kind", row)?,
                    text(batch, "owner_id", row)?,
                    text(batch, "owner_revision", row)?,
                    text(batch, "embedding_chunk_id", row)?,
                    text(batch, "embedding_version", row)?
                ])
                .to_string()
                .as_bytes()
            )
        );
        if replacements
            .insert(text(batch, "vector_key", row)?.to_owned(), key.clone())
            .is_some()
        {
            return Err(io::Error::other("Duplicate vector survivor"));
        }
        keys.push(key);
    }
    let schema = batch.schema();
    let mut columns = batch.columns().to_vec();
    let key_column = schema.index_of("vector_key").map_err(io::Error::other)?;
    let generation_column = schema.index_of("generation").map_err(io::Error::other)?;
    *columns
        .get_mut(key_column)
        .ok_or_else(|| io::Error::other("Vector key column is missing"))? =
        Arc::new(StringArray::from(keys));
    *columns
        .get_mut(generation_column)
        .ok_or_else(|| io::Error::other("Generation column is missing"))? =
        Arc::new(StringArray::from(vec![generation; batch.num_rows()]));
    RecordBatch::try_new(schema, columns).map_err(io::Error::other)
}

fn rewrite_receipts(
    db: &Connection,
    generation: &str,
    replacements: &HashMap<String, String>,
) -> io::Result<()> {
    let mut query = db
        .prepare(
            "SELECT unit_id,receipt_json FROM memory_vector_units WHERE receipt_json IS NOT NULL",
        )
        .map_err(io::Error::other)?;
    let rows = query
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(io::Error::other)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io::Error::other)?;
    for (id, receipt) in rows {
        let mut value: Value = serde_json::from_str(&receipt).map_err(io::Error::other)?;
        let object = value
            .as_object_mut()
            .ok_or_else(|| io::Error::other("Invalid vector receipt"))?;
        object.insert("generation".into(), json!(generation));
        if let Some(keys) = object.get_mut("vector_keys").and_then(Value::as_array_mut) {
            for key in keys {
                let replacement = key
                    .as_str()
                    .and_then(|key| replacements.get(key))
                    .ok_or_else(|| io::Error::other("Missing vector receipt survivor"))?;
                *key = json!(replacement);
            }
        }
        db.execute(
            "UPDATE memory_vector_units SET receipt_json=?1 WHERE unit_id=?2",
            rusqlite::params![value.to_string(), id],
        )
        .map_err(io::Error::other)?;
    }
    Ok(())
}

fn check(token: &CancellationToken) -> io::Result<()> {
    if token.is_cancelled() {
        return Err(io::Error::new(io::ErrorKind::Interrupted, "Cancelled"));
    }
    Ok(())
}
