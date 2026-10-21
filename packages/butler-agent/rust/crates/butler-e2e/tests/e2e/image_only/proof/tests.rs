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
fn image_only_proof_uses_first_success_after_retries() -> Result<(), HarnessError> {
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
        first_successful_attempt(&refs).unwrap()["content"]["request"]["attempt"],
        1
    );
    assert!(first_successful_attempt(&refs[..3]).is_none());
    assert!(first_successful_attempt(&[]).is_none());
    let rejected = json!({"attrs":{"status":400}});
    assert!(first_successful_attempt(&[&rejected]).is_none());
    let mut refs = refs;
    refs.push(&rejected);
    assert_eq!(first_successful_attempt(&refs), Some(&rows[3]));
    Ok(())
}

// test-category: pure-logic
#[test]
fn image_only_proof_checks_completion_for_each_protocol() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for event in [
        json!({"type":"response.completed"}),
        json!({"choices":[{"finish_reason":"stop"}]}),
        json!({"type":"message_stop"}),
        json!({"candidates":[{"finishReason":"STOP"}]}),
    ] {
        let body = json!({"response":format!("data: {event}\n\ndata: [DONE]\n")});
        assert_response_ok(&body);
    }
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
