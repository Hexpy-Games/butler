//! Harness configuration from `BUTLER_E2E_*` environment variables.
//!
//! Tier semantics (PROVIDER_CONFIG.md §2):
//! - `stub` (default): live scenarios are skipped with reason `tier`.
//! - `all`: live scenarios run when credentials resolve, otherwise they are
//!   reported `SKIPPED (no credentials: <provider>)`.
//! - `live`: missing credentials fail the scenario; a live result was asked for.

use std::env;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    Stub,
    Live,
    All,
}

impl Tier {
    pub fn from_env() -> Self {
        match env::var("BUTLER_E2E_TIER").as_deref().map(str::trim) {
            Ok("live") => Self::Live,
            Ok("all") => Self::All,
            _ => Self::Stub,
        }
    }

    pub fn runs_live(self) -> bool {
        matches!(self, Self::Live | Self::All)
    }
}

/// A model selection as the product spells it: `provider/model` plus effort.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelChoice {
    pub model: String,
    pub effort: Option<String>,
}

impl ModelChoice {
    /// Parses `provider/model[@effort]`.
    pub fn parse(value: &str) -> Option<Self> {
        let value = value.trim();
        let (model, effort) = match value.split_once('@') {
            Some((model, effort)) => (model, Some(effort.trim().to_owned())),
            None => (value, None),
        };
        let (provider, id) = model.split_once('/')?;
        if provider.is_empty() || id.is_empty() {
            return None;
        }
        Some(Self {
            model: model.trim().to_owned(),
            effort: effort.filter(|effort| !effort.is_empty()),
        })
    }

    pub fn provider(&self) -> &str {
        self.model.split('/').next().unwrap_or_default()
    }

    pub fn label(&self) -> String {
        match &self.effort {
            Some(effort) => format!("{}@{effort}", self.model),
            None => self.model.clone(),
        }
    }
}

/// Where a live credential comes from. Values are never read by the harness:
/// file credentials are handed to the product by path, and key credentials
/// are passed through the product's own environment variable.
#[derive(Clone, Debug)]
pub enum Credential {
    ChatGptAuthDir(PathBuf),
    /// A provider API key held in the named harness environment variable.
    ApiKey {
        env_var: String,
    },
}

/// The selected live provider (PROVIDER_CONFIG.md §2).
#[derive(Clone, Debug)]
pub struct LiveProvider {
    pub provider: String,
    pub choice: ModelChoice,
    pub matrix: Vec<ModelChoice>,
    pub credential: Option<Credential>,
    pub base_url: Option<String>,
}

impl LiveProvider {
    pub fn from_env() -> Result<Self, String> {
        Self::from_vars(&nonempty)
    }

    /// Reads the live selection from `var`. `BUTLER_E2E_PROVIDER` and
    /// `BUTLER_E2E_MODEL` have no default, so no provider is implied; the
    /// error names the missing variable. `BUTLER_E2E_MODEL_MATRIX` defaults
    /// to the model.
    pub fn from_vars(var: &dyn Fn(&str) -> Option<String>) -> Result<Self, String> {
        let provider = var("BUTLER_E2E_PROVIDER").ok_or("BUTLER_E2E_PROVIDER is unset")?;
        let model = var("BUTLER_E2E_MODEL").ok_or("BUTLER_E2E_MODEL is unset")?;
        let choice =
            ModelChoice::parse(&model).ok_or("BUTLER_E2E_MODEL is not provider/model[@effort]")?;
        let matrix = match var("BUTLER_E2E_MODEL_MATRIX") {
            Some(matrix) => matrix.split(',').filter_map(ModelChoice::parse).collect(),
            None => vec![choice.clone()],
        };
        let credential = resolve_credential(&provider, var);
        Ok(Self {
            provider,
            choice,
            matrix,
            credential,
            base_url: var("BUTLER_E2E_BASE_URL"),
        })
    }

    /// Environment variable name of the product's base-URL override for this
    /// provider, or `None` when the provider has no override (custom models
    /// carry their own URL).
    pub fn base_url_env(&self) -> Option<&'static str> {
        base_url_env(&self.provider)
    }

    pub fn upstream_default(&self) -> Option<&'static str> {
        match self.provider.as_str() {
            "openai-subscription" => Some("https://api.openai.com"),
            "openai" => Some("https://api.openai.com/v1"),
            "anthropic" => Some("https://api.anthropic.com/v1"),
            // The origin: the Coding Plan's model and quota endpoints differ
            // in path (see `base_path`).
            "zai" => Some("https://api.z.ai"),
            other => butler_models::models::default_hosted_provider_api_base_url(other),
        }
    }
}

/// The path the product's base URL carries after the recorder's origin, for
/// providers whose upstream default is an origin: the Z.AI Coding Plan's
/// model base, from which the product derives its quota URL.
pub fn base_path(provider: &str) -> &'static str {
    match provider {
        "openai-subscription" => "/v1",
        "zai" => "/api/coding/paas/v4",
        _ => "",
    }
}

pub fn base_url_env(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "openai-subscription" => "BUTLER_CHATGPT_API_BASE_URL",
        "openai" => "OPENAI_BASE_URL",
        "anthropic" => "BUTLER_ANTHROPIC_BASE_URL",
        "google" => "BUTLER_GOOGLE_BASE_URL",
        "xai" => "BUTLER_XAI_BASE_URL",
        "qwen" => "BUTLER_QWEN_BASE_URL",
        "kimi" => "BUTLER_KIMI_BASE_URL",
        "zai" => "BUTLER_ZAI_BASE_URL",
        "zai-api" => "BUTLER_ZAI_API_BASE_URL",
        "opencode-go" => "BUTLER_OPENCODE_GO_BASE_URL",
        _ => return None,
    })
}

fn resolve_credential(provider: &str, var: &dyn Fn(&str) -> Option<String>) -> Option<Credential> {
    if provider == "openai-subscription" {
        let dir = var("BUTLER_E2E_CHATGPT_AUTH_DIR")
            .map(PathBuf::from)
            .or_else(|| {
                butler_platform::user_dirs::home_dir()
                    .map(|home| home.join(".butler-e2e-auth/auth"))
            })?;
        return existing(&dir.join("chatgpt.json")).map(|_| Credential::ChatGptAuthDir(dir));
    }
    let env_var = var("BUTLER_E2E_API_KEY_ENV").unwrap_or_else(|| default_key_env(provider));
    var(&env_var).map(|_| Credential::ApiKey { env_var })
}

fn default_key_env(provider: &str) -> String {
    match provider {
        "opencode-go" => "OPENCODE_GO_API_KEY".into(),
        other => format!("{}_API_KEY", other.to_uppercase().replace('-', "_")),
    }
}

fn existing(path: &Path) -> Option<PathBuf> {
    path.is_file().then(|| path.to_owned())
}

/// True when `BUTLER_E2E_TIER` is set; see [`crate::gate`].
pub fn tier_selected() -> bool {
    let selected = nonempty("BUTLER_E2E_TIER").is_some();
    if !selected {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            eprintln!("butler-e2e: SKIPPED (BUTLER_E2E_TIER unset; run with BUTLER_E2E_TIER=stub)");
        });
    }
    selected
}

pub fn nonempty(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub fn flag(key: &str) -> bool {
    matches!(nonempty(key).as_deref(), Some("1" | "true" | "yes"))
}

/// Spend guard for live runs (`BUTLER_E2E_LIVE_MAX_TURNS`, default 60).
pub fn live_max_turns() -> u32 {
    nonempty("BUTLER_E2E_LIVE_MAX_TURNS")
        .and_then(|value| value.parse().ok())
        .unwrap_or(60)
}
