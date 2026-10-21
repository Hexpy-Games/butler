//! Wire-proof regressions: no provider calls or credentials.
use super::*;
use serde_json::json;

// test-category: pure-logic
#[test]
fn image_only_proof_covers_each_native_serializer() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let bytes = b"image bytes";
    let encoded = STANDARD.encode(bytes);
    for part in [
        json!({"type":"input_image","image_url":format!("data:image/png;base64,{encoded}")}),
        json!({"type":"image_url","image_url":{"url":format!("data:image/png;base64,{encoded}")}}),
        json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":encoded}}),
        json!({"inline_data":{"mime_type":"image/png","data":encoded}}),
    ] {
        let request = json!({"nested":[part]});
        assert_uploaded_image(&request, bytes);
        assert!(!contains_image(&request, b"different bytes"));
    }
    Ok(())
}

// test-category: pure-logic
#[test]
fn image_only_proof_uses_final_success_after_retries() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let rows = [
        json!({"attrs":{"status":429},"error":{"message":"rate limit"}}),
        json!({"attrs":{"status":503},"error":{"message":"unavailable"}}),
        json!({"attrs":{},"error":{"message":"connection reset"}}),
        json!({"attrs":{"status":200},"content":{"request":{"attempt":1}}}),
        json!({"attrs":{"status":200},"error":{"message":"stream reset"}}),
        json!({"attrs":{"status":200},"content":{"request":{"attempt":2}}}),
    ];
    let refs: Vec<_> = rows.iter().collect();
    assert_eq!(
        final_successful_attempt(&refs)["content"]["request"]["attempt"],
        2
    );
    assert!(std::panic::catch_unwind(|| final_successful_attempt(&refs[..3])).is_err());
    let rejected = json!({"attrs":{"status":400}});
    let mut refs = refs;
    refs.push(&rejected);
    assert!(std::panic::catch_unwind(|| final_successful_attempt(&refs)).is_err());
    Ok(())
}

// test-category: pure-logic
#[test]
fn image_only_proof_checks_completion_and_usage_for_each_protocol() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for event in [
        json!({"type":"response.completed","response":{"usage":{"input_tokens":20}}}),
        json!({"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":20}}),
        json!({"type":"message_stop","usage":{"input_tokens":20}}),
        json!({"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":20}}),
    ] {
        let baseline_event = if event.get("usageMetadata").is_some() {
            json!({"usageMetadata":{"promptTokenCount":10}})
        } else if event.get("choices").is_some() {
            json!({"usage":{"prompt_tokens":10}})
        } else {
            json!({"usage":{"input_tokens":10}})
        };
        let baseline = json!({"response":baseline_event});
        let body = json!({"response":format!("data: {event}\n\ndata: [DONE]\n")});
        assert_response_ok(&body);
        assert_image_usage(&baseline, &body);
        assert!(std::panic::catch_unwind(|| assert_image_usage(&body, &baseline)).is_err());
    }
    let no_usage = json!({"response":{"candidates":[{"finishReason":"STOP"}]}});
    assert_image_usage(&no_usage, &no_usage);
    for usage in [
        json!({"input_tokens":1,"input_tokens_details":{"image_tokens":5}}),
        json!({"prompt_tokens":1,"prompt_tokens_details":{"image_tokens":5}}),
        json!({"promptTokenCount":1,"promptTokensDetails":[
            {"modality":"TEXT","tokenCount":30},{"modality":"IMAGE","tokenCount":2},
            {"modality":"IMAGE","tokenCount":3}
        ]}),
    ] {
        assert_eq!(image_tokens(&usage), Some(5));
        assert_image_usage(&no_usage, &json!({"response":{"usage":usage}}));
    }
    let zero_image = json!({"response":{"usageMetadata":{
        "promptTokenCount":100,"promptTokensDetails":[{"modality":"IMAGE","tokenCount":0}]
    }}});
    assert!(std::panic::catch_unwind(|| assert_image_usage(&no_usage, &zero_image)).is_err());
    for event in [
        json!({"candidates":[{"content":{"parts":[{"text":"unfinished"}]}}]}),
        json!({"candidates":[{"finishReason":"STOP"}],"error":{"message":"failed"}}),
    ] {
        assert!(
            std::panic::catch_unwind(|| assert_response_ok(&json!({"response":event}))).is_err()
        );
    }
    Ok(())
}
