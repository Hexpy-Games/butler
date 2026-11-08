//! The wire shapes of a Custom model (`AppModelSummary`, `LocalModelDiscoveryResult`) and the
//! numbers the form derives from them (`localModelApi.ts`).
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `LocalModelDiscoveryRequest["platform"]`
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Platform {
    LlamaCpp,
    Ollama,
    LmStudio,
    Custom,
}

impl Platform {
    pub(super) const ALL: [Self; 4] = [Self::LlamaCpp, Self::Ollama, Self::LmStudio, Self::Custom];

    pub(super) fn wire(self) -> &'static str {
        match self {
            Self::LlamaCpp => "llama_cpp",
            Self::Ollama => "ollama",
            Self::LmStudio => "lm_studio",
            Self::Custom => "custom",
        }
    }

    pub(super) fn from_wire(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|platform| platform.wire() == value)
    }
}

/// The fields of an `AppModelSummary` this form reads.
#[derive(Clone, Debug, Deserialize)]
pub(super) struct LocalModel {
    pub(super) model_ref: String,
    pub(super) model_id: String,
    pub(super) display_name: Option<String>,
    pub(super) context_window_tokens: Option<f64>,
    pub(super) max_output_tokens: Option<f64>,
    pub(super) platform: Option<Platform>,
    pub(super) api_base_url: Option<String>,
    pub(super) server_url: Option<String>,
    pub(super) local_reasoning_budget_ratio: Option<f64>,
    /// A Custom model's own response time limit, in milliseconds.
    pub(super) response_timeout_ms: Option<f64>,
    pub(super) image_input_support: Option<String>,
}

impl LocalModel {
    /// `modelDisplayName`
    pub(super) fn name(&self) -> &str {
        self.display_name
            .as_deref()
            .filter(|name| !name.is_empty())
            .unwrap_or(&self.model_id)
    }

    /// `model.api_base_url ?? model.server_url ?? ""`
    pub(super) fn url(&self) -> &str {
        self.api_base_url
            .as_deref()
            .or(self.server_url.as_deref())
            .unwrap_or_default()
    }

    pub(super) fn context_text(&self) -> String {
        self.context_window_tokens
            .map(|tokens| tokens.to_string())
            .unwrap_or_default()
    }

    pub(super) fn timeout_text(&self) -> String {
        seconds_text(self.response_timeout_ms)
    }

    pub(super) fn supports_images(&self) -> bool {
        self.image_input_support.as_deref() == Some("supported")
    }
}

/// `LocalModelDiscoveryResult`
#[derive(Deserialize)]
pub(super) struct Discovered {
    pub(super) models: Vec<LocalModel>,
}

/// `LocalModelRegistrationResult`; the catalog is read again with `reload_catalog`.
#[derive(Deserialize)]
pub(super) struct Registered {
    pub(super) model: LocalModel,
}

/// `ResponseTimeoutLimits`
#[derive(Clone, Copy, Debug, Deserialize)]
pub(super) struct Limits {
    #[serde(rename = "default_ms")]
    pub(super) default: f64,
    #[serde(rename = "min_ms")]
    pub(super) min: f64,
    #[serde(rename = "max_ms")]
    pub(super) max: f64,
}

/// A registered Custom model of the catalog, by its ref.
pub(super) fn find_local(catalog: &Value, model_ref: &str) -> Option<LocalModel> {
    let model = catalog
        .get("models")?
        .as_array()?
        .iter()
        .find(|model| model.get("model_ref").and_then(Value::as_str) == Some(model_ref))?;
    LocalModel::deserialize(model).ok()
}

/// A stored limit as the seconds the field shows; empty when unset.
pub(super) fn seconds_text(milliseconds: Option<f64>) -> String {
    milliseconds
        .filter(|ms| *ms != 0.)
        .map(|ms| (ms / 1000.).to_string())
        .unwrap_or_default()
}

/// `responseTimeoutMs`: the entry in seconds, against the agent's limits.
pub(super) enum Timeout {
    Unset,
    Ms(i64),
    Invalid,
}

pub(super) fn response_timeout(seconds: &str, limits: Option<&Limits>) -> Timeout {
    let text = seconds.trim();
    if text.is_empty() {
        return Timeout::Unset;
    }
    let Some(value) = text.parse::<f64>().ok().filter(|value| value.is_finite()) else {
        return Timeout::Invalid;
    };
    let ms = (value * 1000.).round();
    let in_range = match limits {
        Some(limits) => ms >= limits.min && ms <= limits.max,
        None => ms > 0.,
    };
    if in_range {
        #[expect(clippy::cast_possible_truncation, reason = "rounded milliseconds")]
        let ms = ms as i64;
        Timeout::Ms(ms)
    } else {
        Timeout::Invalid
    }
}

/// `tokenWindowLabel`
pub(super) fn token_window_label(tokens: Option<f64>, unknown: &str) -> String {
    let Some(tokens) = tokens.filter(|tokens| tokens.is_finite()) else {
        return unknown.to_owned();
    };
    if tokens >= 1_000_000. {
        let millions = format!("{:.2}", tokens / 1_000_000.);
        let millions = millions.trim_end_matches('0').trim_end_matches('.');
        return format!("{millions}M API context");
    }
    format!("{}k API context", (tokens / 1000.).round())
}
