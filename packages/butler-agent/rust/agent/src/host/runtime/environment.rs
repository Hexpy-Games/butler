//! One process-owned snapshot of source environment inputs.
//!
//! Domain owners retain their own validation and default policies. In particular,
//! credential strings stay private and this snapshot has no Debug/Serialize view.

use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};

use crate::cognition::CognitionPathEnvironment;
use crate::context::{ContextBudgetEnvironment, PromptEnvironment};
use crate::models::ModelConfigurationEnvironment;

pub(crate) struct NativeProcessEnvironment {
    pub model: ModelConfigurationEnvironment,
    pub prompt: PromptEnvironment,
    pub context_budget: ContextBudgetEnvironment,
    pub cognition_paths: CognitionPathEnvironment,
    pub phase_surface_flag: String,
    pub operation_replay_flag: String,
    pub model_route_retry_base_ms: f64,
}

impl NativeProcessEnvironment {
    /// Capture once at process composition. Paths and OS release are host facts,
    /// supplied by the caller rather than rediscovered by each domain owner.
    pub(crate) fn capture(_data_root: &Path, user_home: &Path, os_release: &str) -> Self {
        let mut hosted_provider_base_urls = HashMap::new();
        for (provider, key) in [
            ("anthropic", "BUTLER_ANTHROPIC_BASE_URL"),
            ("google", "BUTLER_GOOGLE_BASE_URL"),
            ("xai", "BUTLER_XAI_BASE_URL"),
            ("qwen", "BUTLER_QWEN_BASE_URL"),
            ("kimi", "BUTLER_KIMI_BASE_URL"),
            ("zai", "BUTLER_ZAI_BASE_URL"),
            ("zai-api", "BUTLER_ZAI_API_BASE_URL"),
            ("opencode-go", "BUTLER_OPENCODE_GO_BASE_URL"),
        ] {
            if let Some(value) = trimmed(key) {
                hosted_provider_base_urls.insert(provider.to_owned(), value);
            }
        }

        let model = ModelConfigurationEnvironment {
            openai_model: optional("BUTLER_OPENAI_MODEL"),
            openai_reasoning_effort: optional("BUTLER_OPENAI_REASONING_EFFORT"),
            codex_base_url: optional("BUTLER_CODEX_BASE_URL"),
            retry_attempts: optional("BUTLER_MODEL_API_RETRY_ATTEMPTS"),
            provider_retry_base_delay_ms: optional("BUTLER_MODEL_API_RETRY_DELAY_MS"),
            openai_api_key: optional("OPENAI_API_KEY"),
            openai_base_url: optional("OPENAI_BASE_URL"),
            provider_round_timeout_ms: optional("BUTLER_PROVIDER_ROUND_TIMEOUT_MS"),
            provider_round_idle_timeout_ms: optional("BUTLER_PROVIDER_ROUND_IDLE_TIMEOUT_MS"),
            openai_prompt_cache_key_prefix: optional("BUTLER_OPENAI_PROMPT_CACHE_KEY_PREFIX"),
            openai_prompt_cache_retention: optional("BUTLER_OPENAI_PROMPT_CACHE_RETENTION"),
            butler_codex_auth_profile: nonempty_path("BUTLER_CODEX_AUTH_PROFILE"),
            butler_openai_auth_profile: nonempty_path("BUTLER_OPENAI_AUTH_PROFILE"),
            codex_auth_json: nonempty_path("CODEX_AUTH_JSON"),
            codex_home: Some(
                nonempty_path("CODEX_HOME").unwrap_or_else(|| user_home.join(".codex")),
            ),
            oauth_authorize_url: first_nonempty_raw(&[
                "BUTLER_CODEX_OAUTH_AUTHORIZE_URL",
                "BUTLER_OPENAI_OAUTH_AUTHORIZE_URL",
            ]),
            oauth_token_url: first_nonempty_raw(&[
                "BUTLER_CODEX_OAUTH_TOKEN_URL",
                "BUTLER_OPENAI_OAUTH_TOKEN_URL",
            ]),
            oauth_client_id: first_trimmed(&[
                "BUTLER_CODEX_OAUTH_CLIENT_ID",
                "BUTLER_OPENAI_OAUTH_CLIENT_ID",
            ]),
            oauth_scope: first_trimmed(&["BUTLER_CODEX_OAUTH_SCOPE", "BUTLER_OPENAI_OAUTH_SCOPE"]),
            oauth_originator: first_trimmed(&[
                "BUTLER_CODEX_OAUTH_ORIGINATOR",
                "BUTLER_OPENAI_OAUTH_ORIGINATOR",
            ]),
            codex_user_agent: trimmed("BUTLER_CODEX_USER_AGENT"),
            os_platform: Some(match env::consts::OS {
                "macos" => "darwin".to_owned(),
                "windows" => "win32".to_owned(),
                other => other.to_owned(),
            }),
            os_release: Some(os_release.to_owned()),
            os_arch: Some(match env::consts::ARCH {
                "x86_64" => "x64".to_owned(),
                "aarch64" => "arm64".to_owned(),
                "x86" => "ia32".to_owned(),
                other => other.to_owned(),
            }),
            hosted_provider_base_urls,
        };
        let retry = model
            .provider_retry_base_delay_ms
            .as_deref()
            .map(crate::json::number_from_string)
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
            phase_surface_flag: optional("BUTLER_PHASE_TOOL_SURFACE").unwrap_or_default(),
            operation_replay_flag: optional("BUTLER_OPERATION_RESULT_REPLAY").unwrap_or_default(),
            model_route_retry_base_ms: if retry.is_finite() {
                retry.max(0.0)
            } else {
                750.0
            },
        }
    }
}

fn optional(name: &str) -> Option<String> {
    env::var(name).ok()
}

fn trimmed(name: &str) -> Option<String> {
    optional(name)
        .map(|value| crate::public_text::trim_js_whitespace(&value).to_owned())
        .filter(|value| !value.is_empty())
}

fn nonempty_path(name: &str) -> Option<PathBuf> {
    optional(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn first_nonempty_raw(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| optional(name).filter(|value| !value.is_empty()))
}

fn first_trimmed(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| trimmed(name))
}
