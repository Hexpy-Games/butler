//! The form's values (`useLocalModelState`), the unsaved-change check
//! (`useLocalModelUnsavedGuard`) and the request bodies (`localModelApi.ts`).
use serde_json::{Map, Value, json};

use super::model::{Limits, LocalModel, Platform, Timeout, response_timeout};

/// The context window a registration starts with and falls back to.
const DEFAULT_CONTEXT: f64 = 16_384.;

pub(super) struct Form {
    pub(super) platform: Platform,
    /// `None` keeps the saved key; `Some("")` removes it.
    pub(super) api_key: Option<String>,
    pub(super) server_url: String,
    pub(super) selected_ref: String,
    pub(super) model_id: String,
    pub(super) display_name: String,
    pub(super) context: String,
    pub(super) timeout: String,
    pub(super) editing_ref: String,
    /// The switch starts at the model's effective support (off for a manual entry); a choice
    /// is kept only once made.
    image_initial: bool,
    image_choice: Option<bool>,
}

impl Default for Form {
    fn default() -> Self {
        Self {
            platform: Platform::Custom,
            api_key: None,
            server_url: String::new(),
            selected_ref: String::new(),
            model_id: String::new(),
            display_name: String::new(),
            context: DEFAULT_CONTEXT.to_string(),
            timeout: String::new(),
            editing_ref: String::new(),
            image_initial: false,
            image_choice: None,
        }
    }
}

/// `Number(text)` when it is a positive number.
fn positive(text: &str) -> Option<f64> {
    text.trim().parse::<f64>().ok().filter(|value| *value > 0.)
}

/// A whole number as an integer, else as typed.
fn number(value: f64) -> Value {
    if value.fract() == 0. {
        #[expect(clippy::cast_possible_truncation, reason = "a whole number")]
        let whole = value as i64;
        json!(whole)
    } else {
        json!(value)
    }
}

impl Form {
    pub(super) fn is_editing(&self) -> bool {
        !self.editing_ref.is_empty()
    }

    pub(super) fn image_checked(&self) -> bool {
        self.image_choice.unwrap_or(self.image_initial)
    }

    pub(super) fn set_image(&mut self, checked: bool) {
        self.image_choice = Some(checked);
    }

    /// `imageInputChange`: only a switch value that differs from where it started.
    fn image_change(&self) -> Option<bool> {
        self.image_choice
            .filter(|choice| *choice != self.image_initial)
    }

    pub(super) fn timeout_invalid(&self, limits: Option<&Limits>) -> bool {
        matches!(response_timeout(&self.timeout, limits), Timeout::Invalid)
    }

    pub(super) fn can_discover(&self, busy: bool) -> bool {
        !self.server_url.trim().is_empty() && !busy
    }

    pub(super) fn can_register(&self, busy: bool, limits: Option<&Limits>) -> bool {
        !busy
            && !self.server_url.trim().is_empty()
            && !self.model_id.trim().is_empty()
            && positive(&self.context).is_some()
            && !self.timeout_invalid(limits)
    }

    /// `editModel`
    pub(super) fn edit(&mut self, model: &LocalModel) {
        self.editing_ref.clone_from(&model.model_ref);
        self.api_key = None;
        self.selected_ref.clear();
        self.platform = model.platform.unwrap_or(Platform::Custom);
        model.url().clone_into(&mut self.server_url);
        self.model_id.clone_from(&model.model_id);
        self.display_name = model.display_name.clone().unwrap_or_default();
        self.context = model.context_text();
        self.timeout = model.timeout_text();
        self.image_initial = model.supports_images();
        self.image_choice = None;
    }

    /// A new registration starts the switch at what discovery found; an edit keeps the
    /// registered model's value.
    pub(super) fn seed_image_input(&mut self, model: Option<&LocalModel>) {
        if self.is_editing() {
            return;
        }
        self.image_initial = model.is_some_and(LocalModel::supports_images);
        self.image_choice = None;
    }

    /// The model's id, name and context window in the entry fields.
    pub(super) fn fill(&mut self, model: &LocalModel) {
        self.model_id.clone_from(&model.model_id);
        if let Some(name) = &model.display_name {
            self.display_name.clone_from(name);
        }
        if model.context_window_tokens.is_some() {
            self.context = model.context_text();
        }
    }

    /// `hasUnsavedChanges`: an edit that differs from the model it started from.
    pub(super) fn has_unsaved(&self, initial: Option<&LocalModel>) -> bool {
        let Some(initial) = initial.filter(|_| self.is_editing()) else {
            return false;
        };
        self.api_key.is_some()
            || self.image_change().is_some()
            || self.platform != initial.platform.unwrap_or(Platform::LlamaCpp)
            || self.server_url != initial.url()
            || self.model_id != initial.model_id
            || self.display_name != initial.display_name.as_deref().unwrap_or_default()
            || self.context != initial.context_text()
            || self.timeout != initial.timeout_text()
    }

    /// The body of POST /model-catalog/local/discover.
    pub(super) fn discovery_body(&self) -> Value {
        let mut body = Map::new();
        if self.is_editing() {
            body.insert("model_ref".into(), json!(self.editing_ref));
        }
        if let Some(key) = &self.api_key {
            body.insert("api_key".into(), json!(key));
        }
        body.insert("provider_id".into(), json!("local"));
        body.insert("api_type".into(), json!("openai_compatible"));
        body.insert("platform".into(), json!(self.platform));
        body.insert("server_url".into(), json!(self.server_url));
        Value::Object(body)
    }

    /// `localModelPayload`: the typed values first, then the discovered model they came from.
    pub(super) fn payload(&self, source: Option<&LocalModel>, ratio: Option<f64>) -> Value {
        let or = |typed: &str, stored: Option<&str>| {
            if typed.is_empty() {
                stored.unwrap_or_default().to_owned()
            } else {
                typed.to_owned()
            }
        };
        let mut body = Map::new();
        if let Some(key) = &self.api_key {
            body.insert("api_key".into(), json!(key));
        }
        body.insert("provider_id".into(), json!("local"));
        body.insert("api_type".into(), json!("openai_compatible"));
        body.insert("platform".into(), json!(self.platform));
        body.insert(
            "server_url".into(),
            json!(or(
                &self.server_url,
                source.and_then(|m| m.server_url.as_deref())
            )),
        );
        body.insert(
            "model_id".into(),
            json!(or(&self.model_id, source.map(|m| m.model_id.as_str()))),
        );
        let name = or(
            &self.display_name,
            source.and_then(|m| m.display_name.as_deref()),
        );
        if !name.is_empty() {
            body.insert("display_name".into(), json!(name));
        }
        let context = positive(&self.context)
            .or(source.and_then(|m| m.context_window_tokens))
            .unwrap_or(DEFAULT_CONTEXT);
        body.insert("context_window_tokens".into(), number(context));
        if let Some(tokens) = source.and_then(|m| m.max_output_tokens) {
            body.insert("max_output_tokens".into(), number(tokens));
        }
        if let Some(ratio) = ratio {
            body.insert("reasoning_budget_ratio".into(), json!(ratio));
        }
        body.insert(
            "source".into(),
            json!(if source.is_some() {
                "discovered"
            } else {
                "manual"
            }),
        );
        if let Some(image) = self.image_change() {
            body.insert("image_input".into(), json!(image));
        }
        match response_timeout(&self.timeout, None) {
            Timeout::Unset => body.insert("response_timeout_ms".into(), Value::Null),
            Timeout::Ms(ms) => body.insert("response_timeout_ms".into(), json!(ms)),
            Timeout::Invalid => None,
        };
        Value::Object(body)
    }
}
