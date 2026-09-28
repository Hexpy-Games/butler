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
    /// Butler OAuth profile (refreshable), passed as `BUTLER_CODEX_AUTH_PROFILE`.
    CodexProfile(PathBuf),
    /// Codex CLI `auth.json` (read-only mode), passed as `CODEX_AUTH_JSON`.
    CodexAuthJson(PathBuf),
    /// A provider API key held in the named harness environment variable.
    ApiKey { env_var: String },
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

pub const DEFAULT_LIVE_MODEL: &str = "openai/gpt-6-luna@max";
/// Owner decision: automated real calls use gpt-6-luna only (never
/// gpt-6-sol or -astra), so the LIVE-07 matrix defaults to it alone; set
/// `BUTLER_E2E_MODEL_MATRIX` to check more entries.
pub const DEFAULT_LIVE_MATRIX: &str = "openai/gpt-6-luna@max";

impl LiveProvider {
    pub fn from_env() -> Self {
        let provider =
            nonempty("BUTLER_E2E_PROVIDER").unwrap_or_else(|| "openai-subscription".into());
        let choice = nonempty("BUTLER_E2E_MODEL")
            .and_then(|value| ModelChoice::parse(&value))
            .or_else(|| ModelChoice::parse(DEFAULT_LIVE_MODEL))
            .unwrap_or(ModelChoice {
                model: "openai/gpt-6-luna".into(),
                effort: Some("max".into()),
            });
        let matrix = nonempty("BUTLER_E2E_MODEL_MATRIX")
            .unwrap_or_else(|| DEFAULT_LIVE_MATRIX.into())
            .split(',')
            .filter_map(ModelChoice::parse)
            .collect();
        let credential = resolve_credential(&provider);
        Self {
            provider,
            choice,
            matrix,
            credential,
            base_url: nonempty("BUTLER_E2E_BASE_URL"),
        }
    }

    /// Environment variable name of the product's base-URL override for this
    /// provider, or `None` when the provider has no override (custom models
    /// carry their own URL).
    pub fn base_url_env(&self) -> Option<&'static str> {
        base_url_env(&self.provider)
    }

    pub fn upstream_default(&self) -> Option<&'static str> {
        match self.provider.as_str() {
            "openai-subscription" => Some("https://chatgpt.com/backend-api"),
            "openai" => Some("https://api.openai.com/v1"),
            "opencode-go" => Some("https://opencode.ai/zen/go/v1"),
            // The origin: the Coding Plan's model and quota endpoints differ
            // in path (see `base_path`).
            "zai" => Some("https://api.z.ai"),
            _ => None,
        }
    }
}

/// The path the product's base URL carries after the recorder's origin, for
/// providers whose upstream default is an origin: the Z.AI Coding Plan's
/// model base, from which the product derives its quota URL.
pub fn base_path(provider: &str) -> &'static str {
    match provider {
        "zai" => "/api/coding/paas/v4",
        _ => "",
    }
}

pub fn base_url_env(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "openai-subscription" => "BUTLER_CODEX_BASE_URL",
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

fn resolve_credential(provider: &str) -> Option<Credential> {
    if provider == "openai-subscription" {
        let home = butler_platform::user_dirs::home_dir();
        if let Some(path) = nonempty("BUTLER_E2E_CODEX_PROFILE").map(PathBuf::from) {
            return existing(&path).map(Credential::CodexProfile);
        }
        if let Some(path) = home
            .as_deref()
            .map(|home| home.join(".butler-e2e-auth/auth/openai-codex.json"))
            .and_then(|path| existing(&path))
        {
            return Some(Credential::CodexProfile(path));
        }
        let codex = nonempty("BUTLER_E2E_CODEX_AUTH_JSON")
            .or_else(|| nonempty("CODEX_AUTH_JSON"))
            .map(PathBuf::from)
            .or_else(|| home.map(|home| home.join(".codex/auth.json")));
        return codex
            .and_then(|path| existing(&path))
            .map(Credential::CodexAuthJson);
    }
    let env_var = nonempty("BUTLER_E2E_API_KEY_ENV").unwrap_or_else(|| default_key_env(provider));
    nonempty(&env_var).map(|_| Credential::ApiKey { env_var })
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
