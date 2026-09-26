use super::*;
use crate::btcc::{ModelRoundTool, ToolCallOrigin, ToolChoice};
use serde_json::Map;

#[test]
fn serializers_preserve_gemini_levels_and_openai_stable_prefix_identity() {
    let (catalog, snapshot) = catalog();
    drop(catalog);
    let messages = [ModelRoundMessage {
        role: ModelRoundRole::User,
        content: "hello".into(),
        tool_call_id: None,
        name: None,
        tool_calls: None,
        image_attachments: Vec::new(),
        provider_data: None,
        request_segment_kind: None,
        operation_result_reference: None,
        operation_result_call_id: None,
        continuation_item_id: Some("turn-item-0".into()),
    }];
    let cancellation = CancellationToken::new();
    let mut request = request(
        "openai/gpt-5.5",
        &messages,
        &ReasoningEffort::Medium,
        cancellation,
        None,
    );
    request.instructions = Some("PREFIX dynamic");
    let stable = serde_json::json!({
        "schemaVersion":"butler.stable-provider-cache-prefix.v1",
        "stablePrefixRevision":"revision-1",
        "toolProfileRevision":"tools-1",
        "instructionPrefix":"PREFIX"
    });
    let route = serde_json::json!({
        "schemaVersion":"butler.model-route-request.v1",
        "routeDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "cursor":0,
        "modelRef":"openai/gpt-5.5"
    });
    request.stable_provider_cache_prefix = Some(&stable);
    request.route_context = Some(&route);
    let config = ProviderRequestConfig {
        metadata: snapshot
            .find_model_metadata(Some("openai/gpt-5.5"))
            .unwrap(),
        wire_model: "gpt-5.5".into(),
        endpoint: Url::parse("https://api.openai.com/v1/responses").unwrap(),
        api_shape: None,
        auth: ProviderAuth::ApiKey("test-only".into()),
        policy: ProviderRoundPolicy {
            total: Duration::from_secs(1),
            idle: None,
            retry_base_ms: 0.0,
        },
        retry_attempts: 3.0,
        prompt_cache: ProviderPromptCachePolicy::default(),
        prompt_reasoning_effort: None,
    };
    let body = serialize::body(&request, &config, serialize::Carrier::Responses).unwrap();
    let encoded = crate::json::stringify(&body).unwrap();
    assert_eq!(
        encoded,
        r#"{"model":"gpt-5.5","tool_choice":"auto","reasoning":{"effort":"medium"},"instructions":"PREFIX dynamic","max_output_tokens":64,"store":true,"input":"hello"}"#
    );
    let identity = serialize::provider_cache_identity(&body, &encoded, &request, &config)
        .unwrap()
        .unwrap();
    assert_eq!(identity["providerId"], "openai");
    assert_eq!(identity["serializedStablePrefixBytes"], 94);
    assert_eq!(
        identity["capabilityDigest"],
        "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
    );
    assert_eq!(
        identity["serializedStablePrefixSha256"],
        "41af67d477a09e70211ebec9e99780ce52a8ae4cfb00e387f0d33a8b138cc6d8"
    );

    let mut gemini_request = request;
    gemini_request.reasoning_effort = &ReasoningEffort::Xhigh;
    let gemini = serialize::body(&gemini_request, &config, serialize::Carrier::Gemini).unwrap();
    assert_eq!(
        gemini.pointer("/generationConfig/thinkingConfig/thinkingLevel"),
        Some(&serde_json::json!("HIGH"))
    );
}

#[test]
fn local_text_tool_marker_is_repaired_without_exposing_it_as_visible_text() {
    let messages = [ModelRoundMessage {
        role: ModelRoundRole::User,
        content: "find it".into(),
        tool_call_id: None,
        name: None,
        tool_calls: None,
        image_attachments: Vec::new(),
        provider_data: None,
        request_segment_kind: None,
        operation_result_reference: None,
        operation_result_call_id: None,
        continuation_item_id: Some("turn-item-0".into()),
    }];
    let tools = [ModelRoundTool {
        name: "search_web".into(),
        description: "Search".into(),
        parameters: Map::new(),
        concurrency_safe: None,
        tool_contract_version: None,
    }];
    let mut request = request(
        "local/test",
        &messages,
        &ReasoningEffort::None,
        CancellationToken::new(),
        None,
    );
    request.tools = &tools;
    let response = serde_json::json!({
        "choices":[{"message":{"role":"assistant","content":"<|tool_call>call: search_web {query:\"rust\",}<tool_call|>"}}]
    });
    let result = result::decode(
        response,
        "local",
        "local/test",
        serialize::Carrier::Chat { stream: false },
        0,
        &request,
        None,
    );
    assert_eq!(result.text, None);
    assert_eq!(result.tool_calls.len(), 1);
    assert_eq!(result.tool_calls[0].name, "search_web");
    assert_eq!(result.tool_calls[0].origin, Some(ToolCallOrigin::Text));
    assert_eq!(result.tool_calls[0].arguments["query"], "rust");
}

#[test]
fn local_text_protocol_hides_reasoning_but_preserves_fenced_user_content() {
    let messages = [ModelRoundMessage {
        role: ModelRoundRole::User,
        content: "explain".into(),
        tool_call_id: None,
        name: None,
        tool_calls: None,
        image_attachments: Vec::new(),
        provider_data: None,
        request_segment_kind: None,
        operation_result_reference: None,
        operation_result_call_id: None,
        continuation_item_id: Some("turn-item-0".into()),
    }];
    let tools = [ModelRoundTool {
        name: "search_web".into(),
        description: "Search".into(),
        parameters: Map::new(),
        concurrency_safe: None,
        tool_contract_version: None,
    }];
    let mut input = request(
        "local/test",
        &messages,
        &ReasoningEffort::None,
        CancellationToken::new(),
        None,
    );
    input.tools = &tools;
    let response = serde_json::json!({
        "choices":[{"message":{"role":"assistant","content":[
            {"text":"analysis:\nprivate reasoning\n<|channel|final|>Visible  \n\n\n```text\nanalysis: preserved\n```"},
            {"text":"\n<|tool_call>call: unknown_tool {}<tool_call|>"}
        ]}}]
    });

    let result = result::decode(
        response,
        "local",
        "local/test",
        serialize::Carrier::Chat { stream: false },
        0,
        &input,
        None,
    );

    assert_eq!(
        result.text.as_deref(),
        Some("Visible\n\n```text\nanalysis: preserved\n```")
    );
    assert!(result.tool_calls.is_empty());
}

pub(super) fn carrier_config(
    metadata: ModelProviderMetadata,
    wire_model: &str,
) -> ProviderRequestConfig {
    ProviderRequestConfig {
        metadata,
        wire_model: wire_model.into(),
        endpoint: Url::parse("https://provider.invalid/v1").unwrap(),
        api_shape: None,
        auth: ProviderAuth::ApiKey("test-only".into()),
        policy: ProviderRoundPolicy {
            total: Duration::from_secs(1),
            idle: None,
            retry_base_ms: 0.0,
        },
        retry_attempts: 3.0,
        prompt_cache: ProviderPromptCachePolicy::default(),
        prompt_reasoning_effort: None,
    }
}

#[test]
fn non_openai_carriers_preserve_source_defaults_and_stateless_items() {
    let (_, snapshot) = catalog();
    let tools = [ModelRoundTool {
        name: "search_web".into(),
        description: "Search".into(),
        parameters: Map::new(),
        concurrency_safe: None,
        tool_contract_version: None,
    }];
    let messages = [
        ModelRoundMessage {
            role: ModelRoundRole::User,
            content: "hello".into(),
            tool_call_id: None,
            name: None,
            tool_calls: None,
            image_attachments: Vec::new(),
            provider_data: None,
            request_segment_kind: None,
            operation_result_reference: None,
            operation_result_call_id: None,
            continuation_item_id: Some("turn-item-0".into()),
        },
        ModelRoundMessage {
            role: ModelRoundRole::Assistant,
            content: "ignored fallback".into(),
            tool_call_id: None,
            name: None,
            tool_calls: None,
            image_attachments: Vec::new(),
            provider_data: Some(serde_json::json!([{
                "type":"reasoning",
                "id":"reasoning-1",
                "summary":[]
            }])),
            request_segment_kind: None,
            operation_result_reference: None,
            operation_result_call_id: None,
            continuation_item_id: Some("turn-item-1".into()),
        },
    ];
    let cancellation = CancellationToken::new();
    let mut input = request(
        "fixture/model",
        &messages,
        &ReasoningEffort::Medium,
        cancellation,
        None,
    );
    input.max_output_tokens = None;
    input.tools = &tools;
    input.tool_choice = Some(ToolChoice::Required);

    let anthropic = carrier_config(
        snapshot
            .find_model_metadata(Some("anthropic/claude-fable-5"))
            .unwrap(),
        "claude-fable-5",
    );
    let anthropic_body =
        serialize::body(&input, &anthropic, serialize::Carrier::Anthropic).unwrap();
    assert_eq!(anthropic_body["max_tokens"], 4096.0);
    assert_eq!(anthropic_body["thinking"]["type"], "adaptive");
    assert_eq!(anthropic_body["tool_choice"]["type"], "any");

    let max_effort = ReasoningEffort::Max;
    let mut haiku_input = request(
        "anthropic/claude-haiku-4-5",
        &messages,
        &max_effort,
        CancellationToken::new(),
        None,
    );
    haiku_input.max_output_tokens = None;
    let haiku = carrier_config(
        snapshot
            .find_model_metadata(Some("anthropic/claude-haiku-4-5"))
            .unwrap(),
        "claude-haiku-4-5",
    );
    let haiku_body = serialize::body(&haiku_input, &haiku, serialize::Carrier::Anthropic).unwrap();
    assert_eq!(haiku_body["thinking"]["budget_tokens"], 32768);

    let hosted_responses = carrier_config(
        snapshot
            .find_model_metadata(Some("opencode-go/gpt-5.6-luna"))
            .unwrap(),
        "gpt-5.6-luna",
    );
    let hosted_body =
        serialize::body(&input, &hosted_responses, serialize::Carrier::Responses).unwrap();
    assert!(hosted_body.get("store").is_none());
    assert_eq!(hosted_body["tools"][0]["strict"], false);
    assert_eq!(hosted_body["input"][1]["id"], "reasoning-1");

    let mut local_metadata = snapshot
        .find_model_metadata(Some("qwen/qwen3.7-max"))
        .unwrap();
    local_metadata.provider_id = "local".into();
    local_metadata.model_ref = "local/test".into();
    local_metadata.model_id = "test".into();
    let local = carrier_config(local_metadata, "test");
    let local_body =
        serialize::body(&input, &local, serialize::Carrier::Chat { stream: false }).unwrap();
    assert!(
        local_body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("use only the structured tool-call channel")
    );

    let mut llama_metadata = local.metadata.clone();
    llama_metadata.model_id = "budget-model".into();
    llama_metadata.reasoning_efforts = vec![
        crate::models::ReasoningEffort::None,
        crate::models::ReasoningEffort::High,
    ];
    llama_metadata.local_reasoning_budget_ratio = Some(0.25);
    llama_metadata.max_output_tokens = Some(1001.0);
    llama_metadata.platform = Some(crate::models::LocalModelPlatform::LlamaCpp);
    let llama = carrier_config(llama_metadata, "budget-model");
    let llama_body =
        serialize::body(&input, &llama, serialize::Carrier::Chat { stream: false }).unwrap();
    assert_eq!(llama_body["thinking_budget_tokens"], 250.0);
    assert!(llama_body.get("reasoning_effort").is_none());
}
