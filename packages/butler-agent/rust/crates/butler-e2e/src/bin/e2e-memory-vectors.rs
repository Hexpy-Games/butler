//! Offline fragmentation and full-row inspection of the real Lance table.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "fixture assertions"
)]
use arrow_array::{
    Array, FixedSizeListArray, Float32Array, RecordBatch, RecordBatchIterator, StringArray,
};
use futures_util::TryStreamExt;
use lancedb::{
    Table,
    query::{ExecutableQuery, QueryBase},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};

#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args().collect();
    let data = PathBuf::from(&args[2]);
    let active: Value = serde_json::from_slice(
        &std::fs::read(data.join("cognition/memory/active-generation.json")).unwrap(),
    )
    .unwrap();
    let root = data
        .join("cognition/memory/generations")
        .join(active["generation_id"].as_str().unwrap())
        .join("butler.lance");
    let connection = lancedb::connect(root.to_str().unwrap())
        .read_consistency_interval(Duration::ZERO)
        .execute()
        .await
        .unwrap();
    let table = connection
        .open_table("butler_memory")
        .execute()
        .await
        .unwrap();
    if args[1] == "fragment" {
        fragment(&table).await;
    } else {
        assert_eq!(args[1], "inspect");
    }
    println!("{}", snapshot(&table).await);
}

async fn fragment(table: &Table) {
    let batches: Vec<RecordBatch> = table
        .query()
        .limit(1)
        .execute()
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap();
    let original = batches[0].slice(0, 1);
    // Retired revisions remain physical rows until optimize prunes them. Each
    // append creates a real fragment; these rows cannot pass currentness checks.
    for index in 0..33 {
        let batch = retired_row(&original, index);
        table
            .add(
                Box::new(RecordBatchIterator::new([Ok(batch)], original.schema()))
                    as Box<dyn arrow_array::RecordBatchReader + Send>,
            )
            .execute()
            .await
            .unwrap();
    }
    assert!(table.stats().await.unwrap().fragment_stats.num_fragments > 32);
}

fn retired_row(original: &RecordBatch, index: usize) -> RecordBatch {
    let text = |column| {
        original
            .column(column)
            .as_any()
            .downcast_ref::<StringArray>()
            .unwrap()
            .value(0)
    };
    let digest = |value: Value| format!("{:x}", Sha256::digest(value.to_string()));
    let revision = digest(json!(["retired-revision", index]));
    let chunk = digest(json!(["embedding-chunk", revision, 0, "retired revision"]));
    let key = digest(json!([
        "memory-vector",
        text(1),
        text(2),
        text(3),
        revision,
        chunk,
        text(7)
    ]));
    let mut columns = original.columns().to_vec();
    for (column, value) in [(0, key), (4, revision.clone()), (5, revision), (6, chunk)] {
        columns[column] = Arc::new(StringArray::from(vec![value]));
    }
    RecordBatch::try_new(original.schema(), columns).unwrap()
}

async fn snapshot(table: &Table) -> Value {
    let batches: Vec<RecordBatch> = table
        .query()
        .execute()
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap();
    let mut rows = BTreeMap::new();
    for batch in batches {
        let vectors = batch
            .column(15)
            .as_any()
            .downcast_ref::<FixedSizeListArray>()
            .unwrap();
        for row in 0..batch.num_rows() {
            let mut fields = BTreeMap::new();
            for index in 0..15 {
                let column = batch
                    .column(index)
                    .as_any()
                    .downcast_ref::<StringArray>()
                    .unwrap();
                fields.insert(
                    batch.schema().field(index).name().clone(),
                    if column.is_null(row) {
                        Value::Null
                    } else {
                        json!(column.value(row))
                    },
                );
            }
            let vector = vectors.value(row);
            let vector = vector.as_any().downcast_ref::<Float32Array>().unwrap();
            assert_eq!(vector.len(), 1024);
            let mut digest = Sha256::new();
            for value in vector.values() {
                assert!(value.is_finite());
                digest.update(value.to_le_bytes());
            }
            fields.insert(
                "vector_sha256".into(),
                json!(format!("{:x}", digest.finalize())),
            );
            let key = fields["vector_key"].as_str().unwrap().to_owned();
            assert!(rows.insert(key, fields).is_none(), "duplicate vector key");
        }
    }
    assert_eq!(rows.len(), table.count_rows(None).await.unwrap());
    json!({"row_count":rows.len(), "fragments":table.stats().await.unwrap().fragment_stats.num_fragments, "rows":rows})
}
