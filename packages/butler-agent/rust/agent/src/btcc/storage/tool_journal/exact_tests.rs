use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

use super::*;
use crate::btcc::TurnStore;
use crate::btcc::storage::{BtccRepositories, StorageError, tests::Fixture};
use crate::json::JsonDocument;

#[tokio::test]
async fn source_exact_output_is_stored_hashed_replayed_and_reopened_without_scalar_dom() {
    let fixture = Fixture::activated();
    let storage = BtccStorage::open(fixture.config("exact-journal"))
        .await
        .unwrap();
    let repositories = BtccRepositories::new(storage.clone(), None);
    repositories
        .load_or_admit(&crate::btcc::storage::transition_tests::prepared())
        .await
        .unwrap();
    let journal = ToolJournalRepository::new(storage.clone(), Arc::new(|| "now".into()));
    let cases: Vec<Value> = serde_json::from_str(include_str!("exact-bun-golden.json")).unwrap();
    assert_eq!(cases.len(), 4);
    for case in &cases {
        let call_id = case["callId"].as_str().unwrap();
        let encoded = case["encoded"].as_str().unwrap();
        journal
            .start(ToolJournalStart {
                turn_id: "turn".into(),
                call_id: call_id.into(),
                tool_name: "run_command".into(),
                raw_arguments: "{}".into(),
                arguments: json!({}),
            })
            .await
            .unwrap();
        let output = JsonDocument::from_encoded(encoded.into()).unwrap();
        for _ in 0..2 {
            journal
                .finish(ToolJournalFinish {
                    call_id: call_id.into(),
                    status: ToolJournalFinishStatus::Completed,
                    result: Some(output.clone()),
                    changed_files: None,
                    error_code: None,
                })
                .await
                .unwrap();
        }
        let record = journal
            .find_for_turn("turn".into(), call_id.into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(record.result.as_ref().unwrap().as_str(), encoded);
        assert_eq!(record.result_sha256.as_deref(), case["sha256"].as_str());
        #[derive(Deserialize)]
        struct Projected {
            result: JsonDocument,
        }
        let projected: Projected =
            serde_json::from_str(&serde_json::to_string(&record).unwrap()).unwrap();
        assert_eq!(projected.result.as_str(), encoded);
        let call_id = call_id.to_owned();
        let stored = storage
            .execute(move |db| {
                db.query_row(
                    "SELECT result_json,result_sha256 FROM btcc_guided_tool_calls WHERE call_id=?1",
                    [&call_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .map_err(StorageError::sqlite)
            })
            .await
            .unwrap();
        assert_eq!(stored.0, case["stored"]);
        assert_eq!(stored.1, case["sha256"]);
    }
    storage.close().await.unwrap();
    let reopened = BtccStorage::open(fixture.config("exact-journal-reopen"))
        .await
        .unwrap();
    let journal = ToolJournalRepository::new(reopened.clone(), Arc::new(|| "now".into()));
    for case in cases {
        let record = journal
            .find_for_turn("turn".into(), case["callId"].as_str().unwrap().into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(record.result.unwrap().as_str(), case["encoded"]);
    }
    reopened.execute(|db| {
        db.execute("UPDATE btcc_guided_tool_calls SET result_json='{',result_sha256=?1 WHERE call_id='exact-0'", [crate::btcc::identity::digest("{")]).map_err(StorageError::sqlite)?;
        Ok(())
    }).await.unwrap();
    assert_eq!(
        journal
            .find_for_turn("turn".into(), "exact-0".into())
            .await
            .unwrap_err()
            .code(),
        "tool_journal_json_invalid"
    );
    reopened
        .execute(|db| {
            db.execute(
                "UPDATE btcc_guided_tool_calls SET result_sha256='wrong' WHERE call_id='exact-0'",
                [],
            )
            .map_err(StorageError::sqlite)?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        journal
            .find_for_turn("turn".into(), "exact-0".into())
            .await
            .unwrap_err()
            .code(),
        "operation_result_body_hash_mismatch"
    );
    assert_eq!(
        journal
            .closeout_page("turn".into(), 0, 8)
            .await
            .err()
            .unwrap()
            .code(),
        "operation_result_body_hash_mismatch"
    );
    reopened.close().await.unwrap();
}
