use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use super::{
    atomic_units, bounded,
    compaction::CompactionState,
    serialization::{
        MessageProjection, digest, message_json, messages_json, request_for_messages, request_json,
    },
    summary::{SummaryPort, SummaryRequest, SummarySizing},
};
use crate::btcc::{
    ContextCompactionRecord, ModelRoundError, ModelRoundMessage, ModelRoundRole, ModelRoundToolCall,
};

fn message(role: ModelRoundRole, content: &str) -> ModelRoundMessage {
    ModelRoundMessage {
        role,
        content: Arc::from(content),
        tool_call_id: None,
        name: None,
        tool_calls: None,
        image_attachments: Vec::new(),
        provider_data: None,
        request_segment_kind: None,
        operation_result_reference: None,
        operation_result_call_id: None,
        continuation_item_id: None,
    }
}

struct UnusedSummary;

impl SummaryPort for UnusedSummary {
    fn sizing(&self) -> Result<Option<SummarySizing<'_>>, ModelRoundError> {
        panic!("fitting mandatory context must not request summary sizing")
    }

    fn summarize<'a>(
        &'a self,
        _request: SummaryRequest<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<String, ModelRoundError>> + Send + 'a>> {
        panic!("fitting mandatory context must not summarize")
    }
}

struct FixedSummary(AtomicUsize);

impl SummaryPort for FixedSummary {
    fn sizing(&self) -> Result<Option<SummarySizing<'_>>, ModelRoundError> {
        Ok(None)
    }

    fn summarize<'a>(
        &'a self,
        _request: SummaryRequest<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<String, ModelRoundError>> + Send + 'a>> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Box::pin(async { Ok("short working summary".into()) })
    }
}

#[tokio::test]
async fn summary_creation_and_reuse_keep_one_record_owner() {
    let messages = [
        message(ModelRoundRole::User, "request"),
        message(ModelRoundRole::Assistant, &"history ".repeat(200)),
        message(ModelRoundRole::User, "latest"),
    ];
    let measure = |messages: &[ModelRoundMessage]| {
        messages_json(messages.iter(), MessageProjection::Exact)
            .map(|json| json.len() as f64)
            .map_err(crate::btcc::ContextProjectionError::Contract)
    };
    let producer = FixedSummary(AtomicUsize::new(0));
    let mut state = CompactionState::new(Arc::from([]));
    let first = state
        .prepare(&messages, 1000.0, &measure, &producer)
        .await
        .expect("summary creation");
    let record = first.save_record.expect("new summary record");
    assert_eq!(record.covered_units, 2);
    let summary_calls = producer.0.load(Ordering::Relaxed);
    assert!(summary_calls > 0);
    assert!(first.identity.is_some());
    assert!(
        first
            .messages
            .expect("projected messages")
            .iter()
            .any(|message| { message.content.contains("short working summary") })
    );

    let second = state
        .prepare(&messages, 1000.0, &measure, &producer)
        .await
        .expect("same-prefix reuse");
    assert!(second.save_record.is_none());
    assert!(second.identity.is_some());
    assert_eq!(producer.0.load(Ordering::Relaxed), summary_calls);
}

#[tokio::test]
async fn fitting_all_mandatory_pressure_returns_without_saved_identity() {
    let messages = [message(ModelRoundRole::User, "request")];
    let saved = Arc::new(ContextCompactionRecord {
        source_digest: digest("[]"),
        covered_units: 1,
        summary: Arc::from("saved summary"),
    });
    let mut state = CompactionState::new(Arc::from([saved]));
    let projected = state
        .prepare(&messages, 100.0, &|_| Ok(90.0), &UnusedSummary)
        .await
        .expect("fitting mandatory context");
    assert!(projected.identity.is_none());
    assert!(projected.save_record.is_none());
    assert_eq!(projected.messages.expect("saved projection"), messages);
}

#[test]
fn message_writers_keep_the_persisted_digest_field_order_and_omissions() {
    {
        let mut assistant = message(ModelRoundRole::Assistant, "reply 💡");
        assistant.tool_calls = Some(vec![ModelRoundToolCall {
            id: "call-1".into(),
            name: "tool_call".into(),
            arguments: serde_json::from_value(serde_json::json!({"z":2,"1":"one","a":true}))
                .expect("object arguments"),
            raw_arguments: "{\"z\":2}".into(),
            origin: None,
        }]);
        assistant.provider_data = Some(serde_json::json!({"nested":{"z":"x"}}));
        assistant.request_segment_kind = Some("phase_continuity".into());
        assistant.continuation_item_id = Some("item-1".into());
        let expected = concat!(
            "{\"role\":\"assistant\",\"content\":\"reply 💡\",\"toolCalls\":[",
            "{\"id\":\"call-1\",\"name\":\"tool_call\",\"arguments\":",
            "{\"1\":\"one\",\"z\":2,\"a\":true},\"rawArguments\":\"{\\\"z\\\":2}\"}",
            "],\"providerData\":{\"nested\":{\"z\":\"x\"}},",
            "\"requestSegmentKind\":\"phase_continuity\",\"continuationItemId\":\"item-1\"}"
        );
        // ECMAScript enumerates index keys first, then the insertion order of
        // ordinary keys. This fixture is created through the actual source shape.
        assert_eq!(
            message_json(&assistant, MessageProjection::Exact).unwrap(),
            expected
        );
        let messages = messages_json([&assistant], MessageProjection::Exact).unwrap();
        assert_eq!(
            request_json(None, &[], None, &messages).unwrap(),
            format!("{{\"tools\":[],\"messages\":[{expected}]}}")
        );
        assert_eq!(
            request_for_messages(None, &[], None, &[assistant]).unwrap(),
            format!("{{\"tools\":[],\"messages\":[{expected}]}}")
        );
    }
    {
        // Oracle: Bun toolResultToMessage({ custom_tool, answer: 42, journal-1 })
        // followed by createTurnContinuationItems("request").push(message).
        let mut result = message(
            ModelRoundRole::Tool,
            "{\"ok\":true,\"output\":{\"tool_name\":\"custom_tool\",\"answer\":42}}",
        );
        result.tool_call_id = Some("call-1".into());
        result.name = Some("custom_tool".into());
        result.request_segment_kind = Some("latest_tool_result_delivery".into());
        result.operation_result_call_id = Some("journal-1".into());
        result.continuation_item_id = Some("turn-item-1".into());
        assert_eq!(
            message_json(&result, MessageProjection::Exact).unwrap(),
            concat!(
                "{\"role\":\"tool\",\"toolCallId\":\"call-1\",",
                "\"name\":\"custom_tool\",\"content\":",
                "\"{\\\"ok\\\":true,\\\"output\\\":{\\\"tool_name\\\":\\\"custom_tool\\\",\\\"answer\\\":42}}\",",
                "\"requestSegmentKind\":\"latest_tool_result_delivery\",",
                "\"operationResultCallId\":\"journal-1\",",
                "\"continuationItemId\":\"turn-item-1\"}"
            )
        );

        // The source producer inserts the exact-result reference after the
        // journal call ID, before the cursor's continuation ID.
        result.operation_result_reference = Some(
            serde_json::from_value(serde_json::json!({
                "version": "butler.operation-result-reference.v1",
                "kind": "operation_result",
                "identity": {"kind": "direct", "result_ref": "ref", "tool_name": "custom_tool"},
                "integrity": {"sha256": "a", "revision": null},
                "outcome": {"status": "completed", "success": true,
                    "verification": "stored_exact_available"},
                "availability": {"status": "exact_read_available",
                    "capability": "read_operation_results", "scope": "same_turn"}
            }))
            .expect("typed source reference"),
        );
        let encoded = message_json(&result, MessageProjection::Exact).unwrap();
        assert_eq!(
            digest(&encoded),
            "a836a811802d6af3c2d2a708256dc21e91d0b3f754fb3985597d2f14fc8956cc"
        );
        let source = message_json(&result, MessageProjection::SourceDigest).unwrap();
        assert!(!source.contains("operationResultReference"));
        assert!(source.contains("operationResultCallId"));
    }
    {
        // Oracle: createTurnContinuationItems.identifyResponse({text:"hello",
        // toolCalls:[]}) followed by appendAssistantResponse.
        let mut assistant = message(ModelRoundRole::Assistant, "hello");
        assistant.tool_calls = Some(Vec::new());
        assistant.continuation_item_id = Some("turn-item-1".into());
        assert_eq!(
            message_json(&assistant, MessageProjection::Exact).unwrap(),
            "{\"role\":\"assistant\",\"content\":\"hello\",\"toolCalls\":[],\"continuationItemId\":\"turn-item-1\"}"
        );
    }
}

#[test]
fn bounded_projection_shares_large_content_and_rejects_orphan_results() {
    let content = "x".repeat(256 * 1024);
    let messages = [message(ModelRoundRole::User, &content)];
    let units = atomic_units::build(&messages).unwrap();
    let projected = bounded::project(&messages, &units, 1).unwrap();
    assert_eq!(projected.evicted_atomic_units, 0);
    assert!(projected.messages.is_none());

    let messages = [
        message(ModelRoundRole::User, &content),
        message(ModelRoundRole::Assistant, "older"),
        message(ModelRoundRole::User, "latest"),
    ];
    let units = atomic_units::build(&messages).unwrap();
    let required = messages_json([&messages[0], &messages[2]], MessageProjection::Exact)
        .unwrap()
        .len();
    let projected = bounded::project(&messages, &units, required).unwrap();
    let selected = projected.messages.expect("older unit evicted");
    assert_eq!(projected.evicted_atomic_units, 1);
    assert!(Arc::ptr_eq(&selected[0].content, &messages[0].content));

    let orphan = [
        message(ModelRoundRole::User, "request"),
        message(ModelRoundRole::Tool, "result"),
    ];
    assert_eq!(
        atomic_units::build(&orphan).unwrap_err().code(),
        "turn_tool_protocol_orphan"
    );

    let mut assistant = message(ModelRoundRole::Assistant, "");
    assistant.tool_calls = Some(vec![ModelRoundToolCall {
        id: String::new(),
        name: "tool_call".into(),
        arguments: serde_json::Map::new(),
        raw_arguments: "{}".into(),
        origin: None,
    }]);
    let mut empty_result = message(ModelRoundRole::Tool, "result");
    empty_result.tool_call_id = Some(String::new());
    let protocol = [
        message(ModelRoundRole::User, "request"),
        assistant,
        empty_result,
    ];
    assert_eq!(
        atomic_units::build(&protocol).unwrap_err().code(),
        "turn_tool_protocol_orphan"
    );
}
