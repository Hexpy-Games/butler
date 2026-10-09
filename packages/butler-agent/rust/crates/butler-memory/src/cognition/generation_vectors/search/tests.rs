//! Lance distance contract and a no-overlap semantic ranking fixture.
use super::*;
use crate::cognition::recall::{
    EpisodeRankInput, ExecutedEpisodeChannels, TimeBasis, rank_episodes,
};
use arrow_array::{ArrayRef, FixedSizeListArray, RecordBatchIterator, StringArray};
use arrow_schema::{DataType, Field, Schema};
use std::sync::Arc;

async fn fixture() -> (VectorTable, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!("recall-distance-{}", uuid::Uuid::new_v4()));
    let labels = [
        "bicycle security combination",
        "orchard pruning",
        "tax filing",
    ];
    let mut fields = META
        .iter()
        .map(|name| Field::new(*name, DataType::Utf8, false))
        .collect::<Vec<_>>();
    let item = Arc::new(Field::new("item", DataType::Float32, true));
    fields.push(Field::new(
        "vector",
        DataType::FixedSizeList(item.clone(), 3),
        false,
    ));
    let schema = Arc::new(Schema::new(fields));
    let mut columns = META
        .iter()
        .map(|_| Arc::new(StringArray::from(labels.to_vec())) as ArrayRef)
        .collect::<Vec<_>>();
    // Unit vectors, using the existing three-dimensional mean-pool fixture shape.
    columns.push(Arc::new(FixedSizeListArray::new(
        item,
        3,
        Arc::new(Float32Array::from(vec![
            0.6, 0.8, 0.0, 0.0, 1.0, 0.0, -1.0, 0.0, 0.0,
        ])),
        None,
    )));
    let batch = RecordBatch::try_new(schema.clone(), columns).unwrap();
    let db = lancedb::connect(root.to_str().unwrap())
        .execute()
        .await
        .unwrap();
    let table = db
        .create_table(
            "fixture",
            Box::new(RecordBatchIterator::new([Ok(batch)], schema))
                as Box<dyn arrow_array::RecordBatchReader + Send>,
        )
        .execute()
        .await
        .unwrap();
    assert_eq!(
        table.list_indices().await.unwrap(),
        [] as [lancedb::index::IndexConfig; 0]
    );
    (
        VectorTable {
            table,
            layout: TableLayout::Current,
        },
        root,
    )
}

fn pairs(batches: &[RecordBatch]) -> Vec<(String, f64)> {
    batches
        .iter()
        .flat_map(|batch| {
            let column = distance_column(batch).unwrap();
            (0..batch.num_rows()).map(move |row| {
                (
                    text(batch, 0, row).unwrap(),
                    distance(batch, column, row).unwrap(),
                )
            })
        })
        .collect()
}

fn episode(
    id: &str,
    relevance: f64,
    vector_rank: Option<f64>,
    lexical_rank: Option<f64>,
) -> EpisodeRankInput {
    EpisodeRankInput {
        episode_id: id.into(),
        session_id: Some(id.into()),
        conversation_at: None,
        event_at: None,
        graph_rank: None,
        vector_rank,
        lexical_rank,
        context_rank: None,
        query_relevance: Some(relevance),
        explicit_priority: None,
        salience: None,
        support_count: None,
        half_life_days: None,
    }
}

async fn search_fixture(table: &VectorTable, cosine: bool) -> Vec<(String, f64)> {
    let batches = if cosine {
        table
            .nearest(&[1.0, 0.0, 0.0], "true".into(), 3)
            .await
            .unwrap()
    } else {
        table
            .table
            .vector_search(&[1.0f32, 0.0, 0.0])
            .unwrap()
            .only_if("true")
            .select(Select::columns(&META))
            .limit(3)
            .execute()
            .await
            .unwrap()
            .try_collect::<Vec<_>>()
            .await
            .unwrap()
    };
    pairs(&batches)
}

fn assert_ranking(hits: Vec<(String, f64)>, cosine: bool) {
    let mut values = hits
        .into_iter()
        .enumerate()
        .map(|(index, (id, distance))| {
            episode(
                &id,
                crate::cognition::recall::cosine_relevance(distance),
                Some((index + 1) as f64),
                None,
            )
        })
        .collect::<Vec<_>>();
    // Query "bike lock code": the matching memory has no lexical overlap.
    values.push(episode(
        "unrelated lexical distractor",
        0.5,
        None,
        Some(1.0),
    ));
    let ranked = rank_episodes(
        values,
        ExecutedEpisodeChannels {
            vector: true,
            lexical: true,
            ..Default::default()
        },
        "2026-01-01",
        TimeBasis::Conversation,
        &|_| 0.0,
    );
    assert_eq!(ranked.len(), 4);
    let rank = ranked
        .iter()
        .position(|row| row.input.episode_id == "bicycle security combination")
        .unwrap()
        + 1;
    assert_eq!(rank, if cosine { 1 } else { 2 });
}

pub(crate) async fn cosine_distance_preserves_semantic_relevance() {
    let (table, root) = fixture().await;
    let mut times = [Vec::new(), Vec::new()];
    for index in 0..30 {
        // Pair in alternating order, so host load and warming affect both arms.
        for cosine in if index % 2 == 0 {
            [false, true]
        } else {
            [true, false]
        } {
            let started = std::time::Instant::now();
            let hits = search_fixture(&table, cosine).await;
            times[usize::from(cosine)].push(started.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(hits.len(), 3);
            assert_eq!(
                hits.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
                [
                    "bicycle security combination",
                    "orchard pruning",
                    "tax filing"
                ]
            );
            let expected = if cosine {
                [0.4, 1.0, 2.0]
            } else {
                [0.8, 2.0, 4.0]
            };
            for ((_, actual), expected) in hits.iter().zip(expected) {
                assert!((actual - expected).abs() < 1e-6);
            }
            if index == 0 {
                eprintln!("cosine={cosine} Lance distances: {hits:?}");
            }
            assert_ranking(hits, cosine);
        }
    }
    for (cosine, times) in times.iter_mut().enumerate() {
        times.sort_by(f64::total_cmp);
        eprintln!(
            "cosine={} 30 complete searches median_ms={:.3} p95_ms={:.3} hit@1={} MRR={:.3}",
            cosine == 1,
            times[15],
            times[28],
            cosine,
            if cosine == 1 { 1.0 } else { 0.5 }
        );
    }
    drop(table);
    std::fs::remove_dir_all(root).unwrap();
}
