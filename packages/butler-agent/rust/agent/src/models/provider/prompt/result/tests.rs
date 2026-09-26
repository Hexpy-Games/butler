use serde_json::json;

use super::*;

#[test]
fn responses_usage_preserves_nullable_total_and_zero_output() {
    let decoded = decode(
        &json!({"usage":{"input_tokens":7}}),
        "openai/gpt-5.5",
        Carrier::Responses,
    );
    let usage = decoded.usage.unwrap();
    assert_eq!(usage.prompt_tokens, Some(7.0));
    assert_eq!(usage.total_tokens, None);
    assert_eq!(usage.output_tokens, 0.0);
}

#[test]
fn responses_cache_only_usage_remains_available_for_metrics() {
    let decoded = decode(
        &json!({"usage":{"input_tokens_details":{"cache_write_tokens":3}}}),
        "openai/gpt-5.5",
        Carrier::Responses,
    );
    let usage = decoded.usage.unwrap();
    assert_eq!(usage.prompt_tokens, None);
    assert_eq!(usage.total_tokens, None);
    assert_eq!(decoded.cache_write_tokens, Some(Some(3.0)));
}

#[test]
fn anthropic_usage_computes_total_from_all_input_classes() {
    let decoded = decode(
        &json!({"usage":{"input_tokens":4,"cache_read_input_tokens":2,"cache_creation_input_tokens":1,"output_tokens":3}}),
        "anthropic/claude-sonnet-5",
        Carrier::Anthropic,
    );
    let usage = decoded.usage.unwrap();
    assert_eq!(usage.prompt_tokens, Some(7.0));
    assert_eq!(usage.cached_tokens, 2.0);
    assert_eq!(usage.total_tokens, Some(10.0));
}
