use super::*;
use crate::btcc::storage::{BtccStorage, tests::Fixture};

fn input() -> ContextDocumentInput {
    ContextDocumentInput {
        scope_kind: "session".into(),
        scope_id: "session-a".into(),
        projection_class: "mandatory_hot_cache".into(),
        source_id: "recent-conversation".into(),
        source_revision: "revision:1".into(),
        content: "## Recent Conversation\n\n기억 😀".into(),
    }
}

#[tokio::test]
async fn persisted_document_is_immutable_reopens_and_detects_content_corruption() {
    let fixture = Fixture::activated();
    let storage = BtccStorage::open(fixture.config("context-documents"))
        .await
        .unwrap();
    let repository = BtccRepositories::new(storage.clone(), None);
    let reference = repository.persist_context_document(input()).await.unwrap();
    assert_eq!(
        repository.persist_context_document(input()).await.unwrap(),
        reference
    );
    assert_eq!(
        repository
            .read_context_document(reference.clone())
            .await
            .unwrap()
            .content,
        input().content
    );
    assert_eq!(
        repository
            .resolve_context_document(reference.clone())
            .await
            .unwrap(),
        input().content
    );
    let count: i64 = storage
        .execute(|db| {
            db.query_row("SELECT COUNT(*) FROM btcc_context_documents", [], |row| {
                row.get(0)
            })
            .map_err(StorageError::sqlite)
        })
        .await
        .unwrap();
    assert_eq!(count, 1);
    storage.close().await.unwrap();
    let storage = BtccStorage::open(fixture.config("context-documents-reopened"))
        .await
        .unwrap();
    let repository = BtccRepositories::new(storage.clone(), None);
    assert_eq!(
        repository
            .resolve_context_document(reference.clone())
            .await
            .unwrap(),
        input().content
    );
    storage
        .execute(|db| {
            db.execute("UPDATE btcc_context_documents SET content='tampered'", [])
                .map(|_| ())
                .map_err(StorageError::sqlite)
        })
        .await
        .unwrap();
    assert_eq!(
        repository
            .read_context_document(reference.clone())
            .await
            .unwrap_err()
            .code(),
        "btcc_context_document_identity_invalid"
    );
    assert_eq!(
        repository
            .resolve_context_document(reference)
            .await
            .unwrap_err()
            .code(),
        "context_document_unavailable"
    );
    storage.close().await.unwrap();
}

#[tokio::test]
async fn legacy_resolve_and_strict_read_keep_distinct_source_contracts() {
    let fixture = Fixture::activated();
    let storage = BtccStorage::open(fixture.config("context-documents-strict"))
        .await
        .unwrap();
    let repository = BtccRepositories::new(storage.clone(), None);
    let mut invalid_source = input();
    invalid_source.source_revision = "unsafe revision".into();
    let reference = repository
        .persist_context_document(invalid_source)
        .await
        .unwrap();
    assert_eq!(
        repository
            .resolve_context_document(reference.clone())
            .await
            .unwrap(),
        input().content
    );
    assert_eq!(
        repository
            .read_context_document(reference)
            .await
            .unwrap_err()
            .code(),
        "btcc_context_document_identity_invalid"
    );
    let valid = repository.persist_context_document(input()).await.unwrap();
    storage
        .execute(|db| {
            db.execute("UPDATE btcc_context_documents SET scope_id='other'", [])
                .map(|_| ())
                .map_err(StorageError::sqlite)
        })
        .await
        .unwrap();
    assert_eq!(
        repository
            .read_context_document(valid)
            .await
            .unwrap_err()
            .code(),
        "btcc_context_document_identity_invalid"
    );
    storage.close().await.unwrap();
}
