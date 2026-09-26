use std::sync::Arc;

use serde_json::json;

use super::collect;
use crate::btcc::{
    BtccRepositories, BtccStorage, TestStorageFixture, ToolJournalFinish, ToolJournalFinishStatus,
    ToolJournalRepository, ToolJournalStart, TurnStore, test_prepared_turn,
};
use crate::json::JsonDocument;

#[tokio::test]
async fn completed_command_artifact_projects_from_reopened_real_journal() {
    let fixture = TestStorageFixture::activated();
    let storage = BtccStorage::open(fixture.config("closeout-first"))
        .await
        .unwrap();
    BtccRepositories::new(storage.clone(), None)
        .load_or_admit(&test_prepared_turn())
        .await
        .unwrap();
    let journal = Arc::new(ToolJournalRepository::new(
        storage.clone(),
        Arc::new(|| "now".into()),
    ));
    journal
        .start(ToolJournalStart {
            turn_id: "turn".into(),
            call_id: "command".into(),
            tool_name: "run_command".into(),
            raw_arguments: "{}".into(),
            arguments: json!({}),
        })
        .await
        .unwrap();
    journal.finish(ToolJournalFinish {
        call_id: "command".into(), status: ToolJournalFinishStatus::Completed,
        result: Some(JsonDocument::from_encoded(
            r#"{"ok":true,"verified_output_files":[{"path":"artifacts/report.csv","size_bytes":12,"artifact_kind":"csv_file"}]}"#.into()
        ).unwrap()), changed_files: None, error_code: None,
    }).await.unwrap();
    storage.close().await.unwrap();
    drop(journal);
    let reopened = BtccStorage::open(fixture.config("closeout-reopen"))
        .await
        .unwrap();
    let journal = Arc::new(ToolJournalRepository::new(
        reopened.clone(),
        Arc::new(|| "now".into()),
    ));
    let closeout = collect(&journal, "turn").await.unwrap();
    assert_eq!(closeout.artifacts.len(), 1);
    assert_eq!(
        closeout.artifacts[0].id,
        "artifact-e1daee22babaafad9904a1b6af84513e2bc678e4b97a54c7b7742284720f74a5"
    );
    assert_eq!(
        closeout.artifacts[0].safe_path_label,
        "artifacts/report.csv"
    );
    assert!(closeout.changed_files.is_empty());
    reopened.close().await.unwrap();
}
