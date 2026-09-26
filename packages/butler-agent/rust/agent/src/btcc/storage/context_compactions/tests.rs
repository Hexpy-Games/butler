use super::*;
use crate::btcc::storage::{BtccStorage, tests::Fixture};

#[tokio::test]
async fn records_load_descending_replace_and_reopen() {
    let fixture = Fixture::activated();
    let storage = BtccStorage::open(fixture.config("context-compactions"))
        .await
        .unwrap();
    let repository = ContextCompactionRepository::new(storage.clone());
    for (digest, covered, summary) in [("small", 2, "old"), ("large", 8, "large")] {
        repository
            .save(
                "turn-a",
                &ContextCompactionRecord {
                    source_digest: digest.into(),
                    covered_units: covered,
                    summary: Arc::from(summary),
                },
            )
            .await
            .unwrap();
    }
    repository
        .save(
            "turn-a",
            &ContextCompactionRecord {
                source_digest: "small".into(),
                covered_units: 2,
                summary: Arc::from("replaced"),
            },
        )
        .await
        .unwrap();
    let loaded = repository.load("turn-a").await.unwrap();
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[0].covered_units, 8);
    assert_eq!(loaded[1].summary.as_ref(), "replaced");
    storage.close().await.unwrap();

    let reopened = BtccStorage::open(fixture.config("context-compactions-reopen"))
        .await
        .unwrap();
    let loaded = ContextCompactionRepository::new(reopened.clone())
        .load("turn-a")
        .await
        .unwrap();
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[0].source_digest, "large");
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn negative_covered_units_is_a_typed_corrupt_record() {
    let fixture = Fixture::activated();
    let storage = BtccStorage::open(fixture.config("context-compactions-invalid"))
        .await
        .unwrap();
    storage
        .execute(|connection| {
            connection
                .execute(SAVE, params!["turn-a", "digest", -1_i64, "summary"])
                .map(|_| ())
                .map_err(StorageError::sqlite)
        })
        .await
        .unwrap();
    let error = ContextCompactionRepository::new(storage.clone())
        .load("turn-a")
        .await
        .unwrap_err();
    assert_eq!(error.code(), "context_compaction_record_invalid");
    storage.close().await.unwrap();
}
