use crate::json::JsonDocument;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};

use super::*;
use crate::btcc::TurnStore;
use crate::btcc::storage::{BtccRepositories, StorageError, tests::Fixture};

fn start(call: &str) -> ToolJournalStart {
    ToolJournalStart {
        turn_id: "turn".into(),
        call_id: call.into(),
        tool_name: "read_file".into(),
        raw_arguments: "original raw".into(),
        arguments: json!({"10":"ten","2":"two","label":"e\u{301}","nested":{"z":1,"a":true}}),
    }
}

fn finish() -> ToolJournalFinish {
    ToolJournalFinish {
        call_id: "call".into(),
        status: ToolJournalFinishStatus::Completed,
        result: Some(
            JsonDocument::from_value(&json!({"z":"e\u{301}","10":10,"2":2,"ok":true,"nil":null}))
                .unwrap(),
        ),
        changed_files: Some(vec![
            json!({"path":"source.txt","before":null,"after":"hash"}),
        ]),
        error_code: None,
    }
}

fn assert_golden(value: &impl serde::Serialize, expected: &Value) {
    let actual = serde_json::to_value(value).unwrap();
    // JS JSON numbers are f64, including rowid, but stringify emits integer form.
    assert_eq!(
        crate::json::stringify(&actual).unwrap(),
        crate::json::stringify(expected).unwrap()
    );
}

#[tokio::test]
async fn canonical_turn_journal_matches_bun_identity_delivery_and_reopen() {
    let fixture = Fixture::activated();
    let storage = BtccStorage::open(fixture.config("journal-owner"))
        .await
        .unwrap();
    let repositories = BtccRepositories::new(storage.clone(), None);
    repositories
        .load_or_admit(&crate::btcc::storage::transition_tests::prepared())
        .await
        .unwrap();
    let clock_calls = Arc::new(AtomicUsize::new(0));
    let clock = {
        let calls = clock_calls.clone();
        Arc::new(move || format!("now-{}", calls.fetch_add(1, Ordering::SeqCst) + 1))
    };
    let journal = ToolJournalRepository::new(storage.clone(), clock);
    let expected: Value = serde_json::from_str(include_str!("bun-golden.json")).unwrap();
    journal.start(start("call")).await.unwrap();
    let mut retry = start("call");
    retry.raw_arguments = "different raw allowed".into();
    retry.arguments["label"] = "é".into();
    journal.start(retry).await.unwrap();
    let mut conflict = start("call");
    conflict.turn_id = "another".into();
    assert_eq!(
        journal.start(conflict).await.unwrap_err().message,
        expected["failures"]["startConflict"]
    );
    journal.finish(finish()).await.unwrap();
    journal.finish(finish()).await.unwrap();
    let mut conflict = finish();
    conflict.result = Some(JsonDocument::from_value(&json!({"ok":false})).unwrap());
    assert_eq!(
        journal.finish(conflict).await.unwrap_err().message,
        expected["failures"]["finishConflict"]
    );
    assert_golden(
        &journal
            .find_for_turn("turn".into(), "call".into())
            .await
            .unwrap(),
        &expected["steps"][0],
    );
    assert!(
        journal
            .find_for_turn("another".into(), "call".into())
            .await
            .unwrap()
            .is_none()
    );
    journal
        .admit_delivery("turn".into(), "call".into())
        .await
        .unwrap();
    journal
        .admit_delivery("turn".into(), "call".into())
        .await
        .unwrap();
    assert_golden(
        &journal
            .find_for_turn("turn".into(), "call".into())
            .await
            .unwrap(),
        &expected["steps"][1],
    );
    journal
        .begin_delivery("turn".into(), "call".into(), "round-1".into())
        .await
        .unwrap();
    assert_eq!(
        journal
            .release_deliveries("turn".into(), "wrong".into())
            .await
            .unwrap_err()
            .message,
        expected["failures"]["wrongRelease"]
    );
    journal
        .release_deliveries("turn".into(), "round-1".into())
        .await
        .unwrap();
    journal
        .begin_delivery("turn".into(), "call".into(), "round-2".into())
        .await
        .unwrap();
    for _ in 0..2 {
        journal
            .acknowledge_deliveries("turn".into(), "round-2".into(), "a".repeat(64))
            .await
            .unwrap();
    }
    assert_golden(
        &journal
            .find_for_turn("turn".into(), "call".into())
            .await
            .unwrap(),
        &expected["steps"][2],
    );
    assert_eq!(
        journal
            .acknowledge_deliveries("turn".into(), "round-2".into(), "b".repeat(64))
            .await
            .unwrap_err()
            .message,
        expected["failures"]["differentAck"]
    );
    for _ in 0..2 {
        journal
            .promote_acknowledged("turn".into(), "call".into())
            .await
            .unwrap();
    }
    assert_golden(
        &journal
            .find_for_turn("turn".into(), "call".into())
            .await
            .unwrap(),
        &expected["steps"][3],
    );
    assert_eq!(
        journal
            .acknowledge_deliveries("turn".into(), "round-2".into(), "a".repeat(64))
            .await
            .unwrap_err()
            .message,
        expected["failures"]["ackAfterPromote"]
    );
    for (call, result) in [("absent", None), ("null", Some(Value::Null))] {
        journal.start(start(call)).await.unwrap();
        journal
            .finish(ToolJournalFinish {
                call_id: call.into(),
                status: ToolJournalFinishStatus::Completed,
                result: result
                    .as_ref()
                    .map(|value| JsonDocument::from_value(value).unwrap()),
                changed_files: Some(Vec::new()),
                error_code: Some(String::new()),
            })
            .await
            .unwrap();
    }
    for (call, result) in [("absent", None), ("null", Some(Value::Null))] {
        let record = journal
            .find_for_turn("turn".into(), call.into())
            .await
            .unwrap()
            .unwrap();
        // The journal status tracks the call lifecycle, not the tool outcome:
        // any produced result (including an absent or JSON-null body) is
        // `completed` so it can be admitted for delivery; failure is projected
        // from the result body by the operation-result reader.
        assert_eq!(record.status, "completed");
        assert_eq!(record.result.is_some(), result.is_some());
        if let (Some(actual), Some(expected)) = (record.result, result) {
            assert_eq!(actual.read::<Value>().unwrap(), expected);
        }
    }
    assert_eq!(clock_calls.load(Ordering::SeqCst), 10);
    let times =
        storage
            .execute(|db| {
                db.query_row(
        "SELECT started_at,finished_at FROM btcc_guided_tool_calls WHERE call_id='call'",[],
        |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).map_err(StorageError::sqlite)
            })
            .await
            .unwrap();
    assert_eq!(times, ("now-1".into(), "now-4".into()));
    storage.close().await.unwrap();
    assert_eq!(
        journal
            .find_for_turn("turn".into(), "call".into())
            .await
            .unwrap_err()
            .code,
        "sqlite_owner_closed"
    );
    let reopened = BtccStorage::open(fixture.config("journal-reopened"))
        .await
        .unwrap();
    let journal = ToolJournalRepository::new(reopened.clone(), Arc::new(|| "unused".into()));
    assert_eq!(
        journal
            .find_for_turn("turn".into(), "call".into())
            .await
            .unwrap()
            .unwrap()
            .status,
        "completed"
    );
    reopened
        .execute(|db| {
            db.execute(
                "UPDATE btcc_guided_tool_calls SET result_json='{}' WHERE call_id='call'",
                [],
            )
            .map_err(StorageError::sqlite)?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        journal
            .find_for_turn("turn".into(), "call".into())
            .await
            .unwrap_err()
            .code,
        "operation_result_body_hash_mismatch"
    );
    reopened.close().await.unwrap();
}
