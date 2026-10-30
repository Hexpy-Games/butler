use super::*;

pub(super) fn assert_hosted_chat_catalog_presets_limits_and_wire_policy() {
    let catalog = StaticCatalog::load().unwrap();
    for (provider, model, context, output, effort) in [
        (
            "deepseek",
            "deepseek-flash",
            1_048_576.0,
            393_216.0,
            ReasoningEffort::High,
        ),
        (
            "upstage",
            "solar-mini4",
            512_000.0,
            128_000.0,
            ReasoningEffort::Medium,
        ),
        (
            "motif",
            "motif/motif-3",
            262_144.0,
            32_768.0,
            ReasoningEffort::None,
        ),
    ] {
        let preset = catalog.routine_preset(provider).unwrap();
        assert_eq!(preset.model, format!("{provider}/{model}"));
        assert_eq!(preset.effort, effort);
        let metadata = catalog
            .models
            .iter()
            .find(|m| m.model_ref == preset.model)
            .unwrap();
        assert_eq!(metadata.context_window_tokens, Some(context));
        assert_eq!(metadata.max_output_tokens, Some(output));
        assert!(metadata.runtime_supported);
        assert_eq!(
            metadata.hosted_api_shape,
            Some(HostedApiShape::OpenaiChatCompletions)
        );
        let policy = chat_wire_policy(provider);
        assert!(policy.reasoning_response_field.is_some());
        let mut body = serde_json::json!({"tool_choice":"required"})
            .as_object()
            .unwrap()
            .clone();
        policy.apply(&mut body, Some("none"));
        assert_eq!(body["tool_choice"], "required");
        if provider == "deepseek" {
            assert_eq!(body["thinking"]["type"], "disabled");
        }
        if provider == "motif" {
            assert_eq!(metadata.reasoning_efforts, [] as [ReasoningEffort; 0]);
            assert!(!body.contains_key("reasoning_effort"));
        }
    }
}
