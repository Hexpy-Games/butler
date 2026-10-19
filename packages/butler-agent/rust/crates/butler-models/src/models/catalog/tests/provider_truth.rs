//! Provider lifecycle and Butler wire capability pins.
use super::*;

pub(super) fn assert_provider_truth(catalog: &StaticCatalog) {
    let find = |id: &str| lookup::find_model_metadata(Some(id), &catalog.models).unwrap();
    let adaptive = vec![
        ReasoningEffort::Low,
        ReasoningEffort::Medium,
        ReasoningEffort::High,
        ReasoningEffort::Xhigh,
        ReasoningEffort::Max,
    ];
    for (id, name, efforts, default) in [
        (
            "anthropic/claude-opus-4-7",
            "Claude Opus 4.7",
            adaptive.clone(),
            ReasoningEffort::Medium,
        ),
        (
            "anthropic/claude-sonnet-4-6",
            "Claude Sonnet 4.6",
            vec![
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
                ReasoningEffort::Max,
            ],
            ReasoningEffort::Medium,
        ),
        (
            "xai/grok-4.3",
            "Grok 4.3",
            adaptive[..4].to_vec(),
            ReasoningEffort::Medium,
        ),
        (
            "qwen/qwen3.6-plus",
            "Qwen3.6 Plus",
            vec![ReasoningEffort::None, ReasoningEffort::High],
            ReasoningEffort::High,
        ),
    ] {
        let model = find(id);
        assert!(model.runtime_supported, "{id}");
        assert_eq!(model.status, "available", "{id}");
        assert_eq!(model.display_name, name, "{id}");
        assert_eq!(model.reasoning_efforts, efforts, "{id}");
        assert_eq!(model.default_reasoning_effort, default, "{id}");
        assert_eq!(model.context_window_tokens, Some(1_000_000.0), "{id}");
    }
    for id in [
        "xai/grok-4.20-multi-agent",
        "zai-api/glm-4.7",
        "kimi/kimi-k2.7-code-highspeed",
    ] {
        let model = find(id);
        assert!(!model.runtime_supported, "{id}");
        assert_eq!(model.status, "available", "{id}");
        assert!(model.display_name.ends_with(" (unsupported)"), "{id}");
    }
    let glm = find("zai-api/glm-4.7");
    assert_eq!(
        glm.reasoning_efforts,
        [ReasoningEffort::None, ReasoningEffort::High]
    );
    assert_eq!(glm.default_reasoning_effort, ReasoningEffort::High);
    let retired = find("zai/glm-4.7");
    assert!(!retired.runtime_supported);
    assert_eq!(retired.status, "deprecated");
    assert!(retired.display_name.ends_with(" (retired)"));
}

pub(super) fn assert_lifecycle_suffix(model: &ModelProviderMetadata) {
    let deprecated = model.status == "deprecated";
    assert_eq!(
        deprecated,
        model.display_name.ends_with(" (retired)"),
        "{}",
        model.model_ref
    );
    assert!(
        !deprecated || !model.runtime_supported,
        "{}",
        model.model_ref
    );
    assert_eq!(
        !model.runtime_supported && !deprecated,
        model.display_name.ends_with(" (unsupported)"),
        "{}",
        model.model_ref
    );
}
