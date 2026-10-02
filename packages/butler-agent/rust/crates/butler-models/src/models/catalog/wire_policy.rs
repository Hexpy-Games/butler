//! Model identities with provider-specific wire behavior, owned by the catalog.
pub const ZAI_IMAGE_MODEL: &str = include_str!("zai-image-model.txt");
pub const ANTHROPIC_ADAPTIVE_MODELS: &[&str] =
    &["claude-fable-5", "claude-opus-5", "claude-sonnet-5"];
pub const ANTHROPIC_BUDGET_MODEL: &str = "claude-haiku-4-5";
pub const OPENCODE_THINKING_MODEL: &str = "glm-5.3";
pub const OPENAI_EXPLICIT_CACHE_MODELS: &[&str] = &["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
pub const OPENAI_DYNAMIC_PLAIN_MODEL: &str = "gpt-5.6";
pub const KIMI_ADAPTIVE_MODEL: &str = "kimi-k3";
pub const ZAI_THINKING_REFS: &[&str] = &["zai/glm-5.3", "zai-api/glm-5.3"];
