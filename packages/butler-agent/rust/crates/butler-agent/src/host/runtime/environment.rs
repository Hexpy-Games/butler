//! One process-owned snapshot of source environment inputs.
//!
//! Domain owners retain their own validation and default policies. In particular,
//! credential strings stay private and this snapshot has no Debug/Serialize view.

use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};

use butler_memory::cognition::CognitionPathEnvironment;
use butler_models::models::{ModelConfigurationEnvironment, SecretStoreFacts};
use butler_runtime::context::{ContextBudgetEnvironment, PromptEnvironment};

pub(crate) struct ProcessEnvironment {
    pub model: ModelConfigurationEnvironment,
    pub prompt: PromptEnvironment,
    pub context_budget: ContextBudgetEnvironment,
    pub cognition_paths: CognitionPathEnvironment,
    pub phase_surface_flag: String,
    pub operation_replay_flag: String,
    pub model_route_retry_base_ms: f64,
}

impl ProcessEnvironment {
    /// Capture once at process composition. Paths and OS release are host facts,
    /// supplied by the caller rather than rediscovered by each domain owner.
    pub(crate) fn capture(data_root: &Path, user_home: &Path, os_release: &str) -> Self {
        let model = ModelConfigurationEnvironment {
            openai_model: optional("BUTLER_OPENAI_MODEL"),
            openai_reasoning_effort: optional("BUTLER_OPENAI_REASONING_EFFORT"),
            chatgpt_api_base_url: optional("BUTLER_CHATGPT_API_BASE_URL"),
            retry_attempts: optional("BUTLER_MODEL_API_RETRY_ATTEMPTS"),
            provider_retry_base_delay_ms: optional("BUTLER_MODEL_API_RETRY_DELAY_MS"),
            openai_api_key: optional("OPENAI_API_KEY"),
            openai_base_url: optional("OPENAI_BASE_URL"),
            provider_round_timeout_ms: optional("BUTLER_PROVIDER_ROUND_TIMEOUT_MS"),
            provider_round_idle_timeout_ms: optional("BUTLER_PROVIDER_ROUND_IDLE_TIMEOUT_MS"),
            openai_prompt_cache_key_prefix: optional("BUTLER_OPENAI_PROMPT_CACHE_KEY_PREFIX"),
            openai_prompt_cache_retention: optional("BUTLER_OPENAI_PROMPT_CACHE_RETENTION"),
            chatgpt_auth_issuer: optional("BUTLER_CHATGPT_AUTH_ISSUER"),
            chatgpt_auth_dir: nonempty_path("BUTLER_CHATGPT_AUTH_DIR"),
            chatgpt_oauth_port: optional("BUTLER_CHATGPT_OAUTH_PORT"),
            oauth_callback_bind_host: optional("BUTLER_OAUTH_CALLBACK_BIND_HOST"),
            oauth_no_browser: optional("BUTLER_OAUTH_NO_BROWSER"),
            os_platform: Some(butler_platform::launcher::node_platform().to_owned()),
            os_release: Some(os_release.to_owned()),
            os_arch: Some(match env::consts::ARCH {
                "x86_64" => "x64".to_owned(),
                "aarch64" => "arm64".to_owned(),
                "x86" => "ia32".to_owned(),
                other => other.to_owned(),
            }),
            hosted_provider_base_urls: hosted_provider_base_urls(),
            // Owner-only file unless Developer ID signed or configured (#217).
            secret_store: SecretStoreFacts::capture(data_root, Some(&user_home.join(".butler"))),
        };
        let retry = model
            .provider_retry_base_delay_ms
            .as_deref()
            .map(butler_core::json::number_from_string)
            .unwrap_or(f64::NAN);
        Self {
            model,
            prompt: PromptEnvironment {
                response_language_override: None,
                response_language: optional("BUTLER_RESPONSE_LANGUAGE"),
                user_geo: optional("BUTLER_USER_GEO"),
            },
            context_budget: ContextBudgetEnvironment {
                context_window_tokens: optional("BUTLER_CONTEXT_WINDOW_TOKENS"),
                reserved_output_tokens: optional("BUTLER_CONTEXT_RESERVED_OUTPUT_TOKENS"),
                reserved_tool_tokens: optional("BUTLER_CONTEXT_RESERVED_TOOL_TOKENS"),
                compaction_prompt_reserve_tokens: optional(
                    "BUTLER_CONTEXT_COMPACTION_PROMPT_RESERVE_TOKENS",
                ),
            },
            cognition_paths: CognitionPathEnvironment {
                cognition_home: optional("BUTLER_COGNITION_HOME"),
                memory_home: optional("BUTLER_COGNITION_MEMORY_HOME"),
            },
            phase_surface_flag: optional("BUTLER_PHASE_TOOL_SURFACE")
                .unwrap_or_else(|| "on".into()),
            operation_replay_flag: optional("BUTLER_OPERATION_RESULT_REPLAY").unwrap_or_default(),
            model_route_retry_base_ms: retry_delay(retry),
        }
    }
}

/// Per-provider API base URL overrides (`BUTLER_<PROVIDER>_BASE_URL`).
fn hosted_provider_base_urls() -> HashMap<String, String> {
    let mut urls = HashMap::new();
    for (provider, key) in [
        ("anthropic", "BUTLER_ANTHROPIC_BASE_URL"),
        ("google", "BUTLER_GOOGLE_BASE_URL"),
        ("xai", "BUTLER_XAI_BASE_URL"),
        ("deepseek", "BUTLER_DEEPSEEK_BASE_URL"),
        ("upstage", "BUTLER_UPSTAGE_BASE_URL"),
        ("motif", "BUTLER_MOTIF_BASE_URL"),
        ("qwen", "BUTLER_QWEN_BASE_URL"),
        ("kimi", "BUTLER_KIMI_BASE_URL"),
        ("zai", "BUTLER_ZAI_BASE_URL"),
        ("zai-api", "BUTLER_ZAI_API_BASE_URL"),
        ("opencode-go", "BUTLER_OPENCODE_GO_BASE_URL"),
    ] {
        if let Some(value) = trimmed(key) {
            urls.insert(provider.to_owned(), value);
        }
    }
    urls
}

fn optional(name: &str) -> Option<String> {
    env::var(name).ok()
}

fn trimmed(name: &str) -> Option<String> {
    optional(name)
        .map(|value| butler_core::public_text::trim_js_whitespace(&value).to_owned())
        .filter(|value| !value.is_empty())
}

fn nonempty_path(name: &str) -> Option<PathBuf> {
    optional(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn retry_delay(value: f64) -> f64 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        750.0
    }
}

/// Capture host inputs and warm kernel capabilities off the runtime/DB workers.
pub(super) fn initialize_host() -> std::sync::Arc<HashMap<String, String>> {
    tokio::task::spawn_blocking(butler_platform::command_sandbox::capabilities);
    std::sync::Arc::new(env::vars().collect())
}
