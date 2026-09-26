use crate::json::JsonDocument;
use serde_json::json;
use std::{future::Future, pin::Pin, sync::Arc};

use crate::btcc::TurnStore;
use crate::btcc::storage::{
    BtccRepositories, BtccStorage, OperationResultRepository, TestStorageFixture as Fixture,
    ToolJournalFinish, ToolJournalFinishStatus, ToolJournalRecord, ToolJournalRepository,
    ToolJournalStart,
};

use super::super::contracts::{
    ModelRoundMessage, ModelRoundRequest, ModelRoundResult, ModelRoundRole, ModelRoundToolCall,
};
use super::super::ports::{ModelRoundError, ModelRoundPort};
use super::anchors::latest_work_anchor_indices;
use super::arguments::exact_read_arguments;
use super::contracts::{
    ExactResultReplaySelection, OperationResultRuntimeFactory, OperationResultScope, ReplayMode,
};
use super::runtime::OperationResultReplayFactory;

#[test]
fn reference_and_exact_arguments_match_bun_source_golden() {
    let golden: serde_json::Value = serde_json::from_str(include_str!("bun-golden.json")).unwrap();
    let record = ToolJournalRecord {
        call_id: "call".into(),
        journal_ordinal: None,
        tool_name: " read_file ".into(),
        raw_arguments: "{}".into(),
        arguments: json!({}),
        status: "completed".into(),
        result: Some(JsonDocument::from_value(&json!({"ok":false})).unwrap()),
        changed_files: None,
        result_sha256: Some("a".repeat(64)),
        error_code: Some(" failure Ω / ".into()),
        delivery_state: None,
        delivery_round_id: None,
        delivery_response_sha256: None,
    };
    let stored = crate::btcc::storage::OperationResultReference {
        kind: "direct",
        result_ref: " ref ".into(),
        revision: None,
        work_id: Some(String::new()),
        session_id: None,
        scope_kind: None,
        scope_ref: None,
    };
    let reference = super::reference::reference(&record, stored, true).unwrap();
    assert_eq!(
        serde_json::to_value(reference).unwrap(),
        golden["reference"]
    );
    let args = exact_read_arguments(
        json!({
            "result_ref":" ref ","sha256":"a".repeat(64),"revision":null,
            "work_id":" work ","offset":0,"length":4096,
        })
        .as_object()
        .unwrap(),
    )
    .unwrap();
    assert_eq!(args.result_ref, golden["exactArguments"]["result_ref"]);
    assert_eq!(
        args.work_id.as_deref(),
        golden["exactArguments"]["work_id"].as_str()
    );
}

struct NoMeasurement;

impl ModelRoundPort for NoMeasurement {
    fn run_round<'a>(
        &'a self,
        _: ModelRoundRequest<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<ModelRoundResult, ModelRoundError>> + Send + 'a>> {
        unreachable!("replay economics never calls the model")
    }
}

#[test]
fn exact_read_arguments_preserve_source_bounds_and_nulls() {
    let args = json!({
        "result_ref":"  ref  ",
        "sha256":"a".repeat(64),
        "revision":null,
        "work_id":" work ",
        "offset":0,
        "length":4096
    });
    let parsed = exact_read_arguments(args.as_object().unwrap()).unwrap();
    assert_eq!(parsed.result_ref, "ref");
    assert_eq!(parsed.work_id.as_deref(), Some("work"));
    assert_eq!(parsed.revision, None);
}

#[test]
fn work_anchors_use_last_duplicate_call_and_guided_normalization() {
    let call = |name: &str, raw: &str| ModelRoundToolCall {
        id: "same".into(),
        name: name.into(),
        arguments: Default::default(),
        raw_arguments: raw.into(),
        origin: None,
    };
    let mut first = ModelRoundMessage::user("ignored".into(), None);
    first.tool_calls = Some(vec![call("replace_work_plan", "{}")]);
    let mut second = ModelRoundMessage::user("ignored".into(), None);
    second.tool_calls = Some(vec![call(
        "tool_call",
        r#"{"id":"native:record_work_review","arguments":{}}"#,
    )]);
    let result = ModelRoundMessage {
        role: ModelRoundRole::Tool,
        content: r#"{"ok":true}"#.into(),
        tool_call_id: Some("same".into()),
        name: Some("replace_work_plan".into()),
        tool_calls: None,
        image_attachments: vec![],
        provider_data: None,
        request_segment_kind: None,
        operation_result_reference: None,
        operation_result_call_id: None,
        continuation_item_id: None,
    };
    assert_eq!(
        latest_work_anchor_indices(&[first, second, result]),
        [2].into_iter().collect()
    );
}

#[tokio::test]
async fn real_journal_replays_only_after_accepted_round_and_reads_exact_bytes() {
    let fixture = Fixture::activated();
    let storage = BtccStorage::open(fixture.config("replay-runtime"))
        .await
        .unwrap();
    BtccRepositories::new(storage.clone(), None)
        .load_or_admit(&crate::btcc::storage::test_prepared_turn())
        .await
        .unwrap();
    let journal = Arc::new(ToolJournalRepository::new(
        storage.clone(),
        Arc::new(|| "now".into()),
    ));
    journal
        .start(ToolJournalStart {
            turn_id: "turn".into(),
            call_id: "call".into(),
            tool_name: "read_file".into(),
            raw_arguments: "{}".into(),
            arguments: json!({}),
        })
        .await
        .unwrap();
    journal
        .finish(ToolJournalFinish {
            call_id: "call".into(),
            status: ToolJournalFinishStatus::Completed,
            result: Some(
                JsonDocument::from_value(&json!({"ok":true,"body":"x".repeat(20_000)})).unwrap(),
            ),
            changed_files: None,
            error_code: None,
        })
        .await
        .unwrap();
    let results = Arc::new(OperationResultRepository::new(storage.clone(), None));
    let factory = OperationResultReplayFactory::new(
        ExactResultReplaySelection {
            mode: ReplayMode::Available,
            exact_read_capability: true,
        },
        journal.clone(),
        results.clone(),
    );
    let scope = OperationResultScope {
        turn_id: "turn".into(),
        turn_revision: 1,
        session_id: "session".into(),
        project_ref: None,
        work_id: None,
    };
    let runtime = factory.bind(scope.clone()).unwrap().unwrap();
    let off = OperationResultReplayFactory::new(
        ExactResultReplaySelection {
            mode: ReplayMode::Disabled,
            exact_read_capability: false,
        },
        journal.clone(),
        results.clone(),
    );
    assert!(off.bind(scope.clone()).unwrap().is_none());
    let exact_only = OperationResultReplayFactory::new(
        ExactResultReplaySelection {
            mode: ReplayMode::Disabled,
            exact_read_capability: true,
        },
        journal.clone(),
        results.clone(),
    )
    .bind(scope.clone())
    .unwrap()
    .unwrap();
    assert!(
        exact_only
            .prepare("disabled", &[], &NoMeasurement, None)
            .await
            .unwrap()
            .messages
            .is_none()
    );
    let missing_exact = OperationResultReplayFactory::new(
        ExactResultReplaySelection {
            mode: ReplayMode::Available,
            exact_read_capability: false,
        },
        journal.clone(),
        results.clone(),
    );
    assert_eq!(
        missing_exact.bind(scope).err().unwrap().code,
        "operation_result_exact_read_dependency_missing"
    );
    let stored = journal
        .find_for_turn("turn".into(), "call".into())
        .await
        .unwrap()
        .unwrap();
    let mut message = ModelRoundMessage::user("large original".repeat(2_000), None);
    let original = message.content.clone();
    message.role = ModelRoundRole::Tool;
    message.tool_call_id = Some("call".into());
    message.name = Some("read_file".into());

    let first = runtime
        .prepare(
            "btcc-model-round-0",
            &[message.clone()],
            &NoMeasurement,
            None,
        )
        .await
        .unwrap();
    assert!(first.messages.is_none());
    assert_eq!(
        journal
            .find_for_turn("turn".into(), "call".into())
            .await
            .unwrap()
            .unwrap()
            .delivery_state
            .as_deref(),
        Some("in_flight")
    );
    runtime.failed("btcc-model-round-0").await.unwrap();
    assert_eq!(
        journal
            .find_for_turn("turn".into(), "call".into())
            .await
            .unwrap()
            .unwrap()
            .delivery_state
            .as_deref(),
        Some("pending_delivery")
    );
    assert!(
        runtime
            .prepare(
                "btcc-model-round-0",
                &[message.clone()],
                &NoMeasurement,
                None
            )
            .await
            .unwrap()
            .messages
            .is_none()
    );
    runtime
        .accepted(
            "btcc-model-round-0",
            &super::super::test_data::result("ok", vec![], 0),
        )
        .await
        .unwrap();
    let acknowledged = journal
        .find_for_turn("turn".into(), "call".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(acknowledged.delivery_state.as_deref(), Some("acknowledged"));
    let golden: serde_json::Value = serde_json::from_str(include_str!("bun-golden.json")).unwrap();
    assert_eq!(
        acknowledged.delivery_response_sha256.as_deref(),
        golden["acceptedResponseSha256"].as_str()
    );
    let second = runtime
        .prepare("btcc-model-round-1", &[message], &NoMeasurement, None)
        .await
        .unwrap();
    let projected = second.messages.unwrap();
    assert!(!Arc::ptr_eq(&original, &projected[0].content));
    assert_eq!(
        projected[0].request_segment_kind.as_deref(),
        Some("older_tool_result_projection")
    );
    let reference = projected[0].operation_result_reference.as_ref().unwrap();
    assert_eq!(reference.identity.result_ref, "call");
    let exact = runtime
        .read_tool(
            json!({
                "result_ref":"call", "sha256":stored.result_sha256.unwrap(),
                "revision":null, "work_id":null, "offset":0, "length":16
            })
            .as_object()
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(exact["length"], 16);
    assert_eq!(exact["complete"], false);
    // guided-runtime's Number coercion must reach the real discovery query.
    // There is one recorded row at ordinal1; these arguments cannot silently
    // turn back into the default cursor or through watermark.
    let listed = runtime
        .list_tool(
            json!({"cursor":false,"through":[1],"limit":"1"})
                .as_object()
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(listed["through"], 1.0);
    assert_eq!(listed["entries"].as_array().unwrap().len(), 1);
    for arguments in [json!({"cursor":"1"}), json!({"through":"0"})] {
        let page = runtime
            .list_tool(arguments.as_object().unwrap())
            .await
            .unwrap();
        assert!(page["entries"].as_array().unwrap().is_empty());
    }
    assert!(
        runtime
            .list_tool(json!({"limit":"not a number"}).as_object().unwrap())
            .await
            .is_err()
    );
    storage.close().await.unwrap();
}
