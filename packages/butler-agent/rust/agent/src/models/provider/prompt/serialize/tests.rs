use std::time::Duration;

use serde_json::{Map, json};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::*;
use crate::{
    locale::LocaleCollation,
    models::{
        ModelCatalog, ModelCatalogSnapshotInput, PromptCacheBoundary, PromptJsonSchema,
        PromptUsageAttribution, ProviderAuth, ProviderPromptCachePolicy, ProviderRoundPolicy,
    },
};

fn config(model_ref: &str) -> ProviderRequestConfig {
    let catalog = ModelCatalog::new().unwrap();
    let snapshot = catalog
        .snapshot(
            ModelCatalogSnapshotInput {
                configured_local: vec![],
                extra_models: vec![],
                registered_models: vec![],
                credential_views: vec![],
                default_model_ref: None,
                generated_at: "now".into(),
            },
            &LocaleCollation::new("en-US").unwrap(),
        )
        .unwrap();
    let metadata = snapshot.find_model_metadata(Some(model_ref)).unwrap();
    ProviderRequestConfig {
        wire_model: metadata.model_id.clone(),
        api_shape: metadata.hosted_api_shape,
        metadata,
        endpoint: Url::parse("http://fixture.test/v1").unwrap(),
        auth: ProviderAuth::ApiKey("fixture".into()),
        policy: ProviderRoundPolicy {
            total: Duration::from_secs(1),
            idle: None,
            retry_base_ms: 0.0,
        },
        retry_attempts: 1.0,
        prompt_cache: ProviderPromptCachePolicy::default(),
        prompt_reasoning_effort: None,
    }
}

fn usage() -> PromptUsageAttribution<'static> {
    PromptUsageAttribution {
        turn_id: None,
        phase: None,
        round_index: None,
        reasoning_effort: None,
        requested_output_tokens: Some(321.0),
        budget_state: None,
        budget_state_source: None,
        prompt_sections: None,
    }
}

fn request<'a>(
    reasoning: &'a ReasoningEffort,
    usage: &'a PromptUsageAttribution<'a>,
) -> ProviderPromptRequest<'a> {
    ProviderPromptRequest {
        prompt: "Hello",
        model: None,
        reasoning_effort: Some(reasoning),
        instructions: Some("  System  "),
        response_format: None,
        cache_scope: None,
        cache_boundary: None,
        cancellation: CancellationToken::new(),
        attachments: &[],
        butler_data: None,
        usage_attribution: Some(usage),
        stream_observer: None,
        provider_retry_attempts: None,
    }
}

fn wire(
    request: &ProviderPromptRequest<'_>,
    config: &ProviderRequestConfig,
    carrier: Carrier,
) -> String {
    crate::json::stringify(&body(request, config, carrier).unwrap().body).unwrap()
}

#[test]
fn non_openai_prompt_bodies_match_intercepted_bun_requests() {
    let usage = usage();
    let anthropic = request(&ReasoningEffort::High, &usage);
    assert_eq!(
        wire(
            &anthropic,
            &config("anthropic/claude-haiku-4-5"),
            Carrier::Anthropic,
        ),
        r#"{"model":"claude-haiku-4-5","max_tokens":321,"system":"System","thinking":{"type":"enabled","budget_tokens":8192},"messages":[{"role":"user","content":"Hello"}]}"#
    );

    let gemini = request(&ReasoningEffort::Low, &usage);
    assert_eq!(
        wire(&gemini, &config("google/gemini-3.5-flash"), Carrier::Gemini,),
        r#"{"systemInstruction":{"parts":[{"text":"System"}]},"generationConfig":{"thinkingConfig":{"thinkingLevel":"LOW"},"maxOutputTokens":321},"contents":[{"role":"user","parts":[{"text":"Hello"}]}]}"#
    );

    let qwen = request(&ReasoningEffort::None, &usage);
    assert_eq!(
        wire(
            &qwen,
            &config("qwen/qwen3.7-max"),
            Carrier::Chat { stream: true },
        ),
        r#"{"model":"qwen3.7-max","max_tokens":321,"messages":[{"role":"system","content":"System"},{"role":"user","content":"Hello"}],"stream":true,"enable_thinking":false}"#
    );
}

#[test]
fn hosted_responses_schema_matches_intercepted_bun_request() {
    let usage = usage();
    let schema = Map::from_iter([("type".into(), json!("object"))]);
    let mut request = request(&ReasoningEffort::High, &usage);
    request.response_format = Some(PromptJsonSchema {
        name: "answer",
        schema: &schema,
        strict: Some(false),
    });
    assert_eq!(
        wire(&request, &config("xai/grok-4.5"), Carrier::Responses,),
        r#"{"model":"grok-4.5","instructions":"System","input":"Hello","reasoning":{"effort":"high"},"text":{"format":{"type":"json_schema","name":"answer","schema":{"type":"object"},"strict":false}}}"#
    );
}

#[test]
fn codex_prompt_wraps_unbounded_text_as_user_input() {
    let effort = ReasoningEffort::Medium;
    let usage = usage();
    let schema = Map::from_iter([("type".into(), json!("object"))]);
    let mut request = request(&effort, &usage);
    request.usage_attribution = None;
    request.response_format = Some(PromptJsonSchema {
        name: "memory_meaning_v4",
        schema: &schema,
        strict: Some(true),
    });
    let mut config = config("openai/gpt-6-sol");
    config.auth = ProviderAuth::Codex {
        mode: super::super::super::ProviderAuthMode::CodexOauth,
        authorization: "Bearer fixture".into(),
        account_id: "fixture".into(),
        user_agent: "fixture".into(),
        originator: "fixture".into(),
    };
    let value: serde_json::Value =
        serde_json::from_str(&wire(&request, &config, Carrier::Responses)).unwrap();
    assert_eq!(value["model"], "gpt-6-sol");
    assert_eq!(value["store"], false);
    assert_eq!(value["stream"], true);
    assert_eq!(value["reasoning"], json!({"effort":"medium"}));
    assert_eq!(
        value["input"],
        json!([{"role":"user","content":[{"type":"input_text","text":"Hello"}]}])
    );
    assert_eq!(value["text"]["format"]["name"], "memory_meaning_v4");
    assert_eq!(value["text"]["format"]["strict"], true);
    assert!(value.get("max_output_tokens").is_none());
}

#[test]
fn openai_cache_boundary_matches_intercepted_bun_request() {
    let usage = usage();
    let schema = Map::from_iter([("type".into(), json!("object"))]);
    let mut request = request(&ReasoningEffort::High, &usage);
    request.prompt = "StableDynamic";
    request.instructions = Some("System");
    request.cache_scope = Some("scope");
    request.cache_boundary = Some(PromptCacheBoundary {
        stable_prefix: "Stable",
        dynamic_suffix: "Dynamic",
    });
    request.response_format = Some(PromptJsonSchema {
        name: "answer",
        schema: &schema,
        strict: Some(false),
    });
    let mut config = config("openai/gpt-5.6-sol");
    config.prompt_cache.key_prefix = Some("fixture".into());
    assert_eq!(
        wire(&request, &config, Carrier::Responses),
        r#"{"max_output_tokens":321,"model":"gpt-5.6-sol","store":true,"prompt_cache_key":"fixture:scope","prompt_cache_options":{"mode":"explicit"},"instructions":"System","text":{"format":{"type":"json_schema","name":"answer","schema":{"type":"object"},"strict":false}},"reasoning":{"effort":"high"},"input":[{"role":"user","content":[{"type":"input_text","text":"Stable","prompt_cache_breakpoint":{"mode":"explicit"}},{"type":"input_text","text":"Dynamic"}]}]}"#
    );
}

#[test]
fn unsupported_openai_cache_boundary_keeps_flat_input_and_retention() {
    let usage = usage();
    let mut request = request(&ReasoningEffort::High, &usage);
    request.prompt = "StableDynamic";
    request.instructions = Some("System");
    request.cache_scope = Some("scope");
    request.cache_boundary = Some(PromptCacheBoundary {
        stable_prefix: "Stable",
        dynamic_suffix: "Dynamic",
    });
    let mut config = config("openai/gpt-5.5");
    config.prompt_cache.key_prefix = Some("fixture".into());
    config.prompt_cache.retention = Some(PromptCacheRetention::Hours24);
    let wire = body(&request, &config, Carrier::Responses).unwrap();
    assert_eq!(
        crate::json::stringify(&wire.body).unwrap(),
        r#"{"max_output_tokens":321,"model":"gpt-5.5","store":true,"prompt_cache_key":"fixture:scope","prompt_cache_retention":"24h","instructions":"System","reasoning":{"effort":"high"},"input":"StableDynamic"}"#
    );
    assert_eq!(wire.cache_retention, Some(PromptCacheRetention::Hours24));
}

#[test]
fn openai_prompt_uses_configured_reasoning_only_when_request_omits_it() {
    let usage = usage();
    let explicit = ReasoningEffort::High;
    let mut request = request(&explicit, &usage);
    request.reasoning_effort = None;
    request.instructions = None;
    request.response_format = None;
    let mut config = config("openai/gpt-5.5");
    config.prompt_reasoning_effort = Some(ReasoningEffort::Low);
    assert_eq!(
        wire(&request, &config, Carrier::Responses),
        r#"{"max_output_tokens":321,"model":"gpt-5.5","store":true,"reasoning":{"effort":"low"},"input":"Hello"}"#
    );
    request.reasoning_effort = Some(&explicit);
    assert!(wire(&request, &config, Carrier::Responses).contains(r#""effort":"high""#));
}

#[test]
fn newly_registered_hosted_models_use_their_source_wire_reasoning() {
    let usage = usage();
    let request = request(&ReasoningEffort::High, &usage);
    let anthropic = body(
        &request,
        &config("anthropic/claude-fable-5-1"),
        Carrier::Anthropic,
    )
    .unwrap()
    .body;
    assert_eq!(anthropic["thinking"], json!({"type":"adaptive"}));
    assert_eq!(anthropic["output_config"], json!({"effort":"high"}));

    let go = body(
        &request,
        &config("opencode-go/glm-5.3"),
        Carrier::Chat { stream: true },
    )
    .unwrap()
    .body;
    assert_eq!(go["reasoning_effort"], "high");
    let older_go = body(
        &request,
        &config("opencode-go/glm-5.2"),
        Carrier::Chat { stream: true },
    )
    .unwrap()
    .body;
    assert!(older_go.get("reasoning_effort").is_none());
}
