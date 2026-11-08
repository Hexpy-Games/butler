//! The saved API keys (`useSavedKeys.ts`, `savedKeysApi.ts`, `savedKeysUtils.ts`): the list,
//! replacing a key and deleting one. A key the owner types lives in `draft` until the request
//! takes it; it is never logged, and the draft is dropped on every way out of the field.
use butler_ds::ui::toast::{Toast, ToastId};
use butler_shell_client::Error;
use gpui::Context;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{SecurityAuthority, announce, missing_route};
use crate::ui::settings::confirm::Request;
use crate::ui::settings::state::{Load, fetch};

/// `MIN_KEY_LENGTH` (useKeyVerification.ts)
pub(super) const MIN_KEY_LENGTH: usize = 8;

/// One entry of `GET /credentials` (`SavedCredentialView`).
#[derive(Deserialize)]
pub(super) struct SavedKey {
    pub(super) id: String,
    pub(super) provider_id: String,
    #[serde(default)]
    pub(super) label: String,
    #[serde(default)]
    pub(super) masked_value: String,
    pub(super) storage: Option<String>,
    #[serde(default)]
    pub(super) model_refs: Vec<String>,
}

#[derive(Deserialize)]
struct Reply {
    #[serde(default)]
    credentials: Vec<SavedKey>,
}

/// `ReplaceStatus`: the field's state while a key is checked with the provider.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Check {
    Idle,
    Checking,
    Failed,
}

/// `CredentialDeleteRule`
pub(super) enum Rule {
    Blocked,
    Force(usize),
    Plain,
}

pub(super) struct Keys {
    pub(super) list: Load<Vec<SavedKey>>,
    /// An agent without the routes: the section stays hidden.
    pub(super) unsupported: bool,
    pub(super) busy: Option<String>,
    /// The key whose replace field is open.
    pub(super) replacing: Option<String>,
    pub(super) draft: String,
    pub(super) check: Check,
    toast: Option<ToastId>,
}

impl Default for Keys {
    fn default() -> Self {
        Self {
            list: Load::Loading,
            unsupported: false,
            busy: None,
            replacing: None,
            draft: String::new(),
            check: Check::Idle,
            toast: None,
        }
    }
}

/// `matchesRef`: `openai/gpt-5`, or a bare id the agent namespaces itself.
fn matches_ref(model_ref: &str, candidate: &str) -> bool {
    let value = candidate.trim();
    if value.is_empty() {
        return false;
    }
    if value.contains('/') {
        return model_ref == value;
    }
    model_ref
        .split_once('/')
        .map_or(model_ref, |(_, rest)| rest)
        == value
}

/// `credentialDeleteRule`: the default model's key is never deleted; a key other models use is
/// deleted with `force`, which removes those models too.
fn rule(key: &SavedKey, defaults: &[String]) -> Rule {
    let blocked = key
        .model_refs
        .iter()
        .any(|model| defaults.iter().any(|default| matches_ref(model, default)));
    match (blocked, key.model_refs.len()) {
        (true, _) => Rule::Blocked,
        (false, 0) => Rule::Plain,
        (false, count) => Rule::Force(count),
    }
}

impl SecurityAuthority {
    /// `defaultModelRefs`: the saved main model and the catalog's configured default.
    fn default_models(&self, cx: &gpui::App) -> Vec<String> {
        let state = self.ctx.state.read(cx);
        let text = |value: Option<&Value>, name: &str| {
            value
                .and_then(|value| value.get(name))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        vec![
            text(state.settings(), "model"),
            text(state.catalog(), "default_model_ref"),
        ]
    }

    pub(super) fn delete_rule(&self, key: &SavedKey, cx: &gpui::App) -> Rule {
        rule(key, &self.default_models(cx))
    }

    /// `credentialDisplayName`: "OpenAI", or "OpenAI / work" when the key has its own name.
    pub(super) fn key_name(&self, key: &SavedKey, cx: &gpui::App) -> String {
        let provider = self
            .ctx
            .state
            .read(cx)
            .catalog()
            .and_then(|catalog| catalog.get("providers"))
            .and_then(Value::as_array)
            .and_then(|providers| {
                providers.iter().find(|provider| {
                    provider.get("provider_id").and_then(Value::as_str) == Some(&key.provider_id)
                })
            })
            .and_then(|provider| provider.get("provider_label").and_then(Value::as_str))
            .unwrap_or(&key.provider_id);
        if !key.label.is_empty() && key.label != key.provider_id {
            format!("{provider} / {}", key.label)
        } else {
            provider.to_owned()
        }
    }

    /// `useSavedKeys.load`
    pub(super) fn load_keys(&mut self, quiet: bool, cx: &mut Context<Self>) {
        if !quiet {
            self.keys.list = Load::Loading;
        }
        fetch(
            cx,
            |client| async move { client.list_credentials().await },
            move |this: &mut Self, result: Result<Reply, Error>, _| match result {
                Ok(reply) => {
                    this.keys.unsupported = false;
                    this.keys.list = Load::Ready(reply.credentials);
                }
                Err(error) if !quiet => {
                    this.keys.unsupported = missing_route(&error);
                    this.keys.list = Load::Failed;
                }
                Err(_) => {}
            },
        );
    }

    /// `refresh`: the keys again, and the model catalog that lists their models.
    fn refresh_keys(&mut self, cx: &mut Context<Self>) {
        self.load_keys(true, cx);
        self.ctx.reload_catalog(cx);
    }

    /// Opens the replace field of a key.
    pub(super) fn begin_replace(&mut self, id: String, cx: &mut Context<Self>) {
        self.end_replace();
        self.keys.replacing = Some(id);
        cx.notify();
    }

    /// Closes the replace field and drops what was typed.
    pub(super) fn end_replace(&mut self) {
        self.keys.replacing = None;
        self.keys.draft = String::new();
        self.keys.check = Check::Idle;
    }

    /// The key typed so far (`onChange` of the field); an edit clears a failure.
    pub(super) fn edit_draft(&mut self, text: &str, cx: &mut Context<Self>) {
        text.clone_into(&mut self.keys.draft);
        if self.keys.check == Check::Failed {
            self.keys.check = Check::Idle;
        }
        cx.notify();
    }

    pub(super) fn draft_ready(&self) -> bool {
        self.keys.draft.trim().chars().count() >= MIN_KEY_LENGTH
            && self.keys.check != Check::Checking
    }

    /// `useSavedKeys.replace`: the provider checks the new key first (`verify`), so a refused key
    /// changes nothing. The client reports no key-check code, so a refusal reads as "couldn't
    /// save the key" (React's fallback for an unknown code).
    pub(super) fn submit_replace(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.keys.replacing.clone() else {
            return;
        };
        let Load::Ready(list) = &self.keys.list else {
            return;
        };
        let Some(key) = list.iter().find(|key| key.id == id) else {
            return;
        };
        if !self.draft_ready() {
            return;
        }
        let name = self.key_name(key, cx);
        let api_key = self.keys.draft.trim().to_owned();
        self.keys.check = Check::Checking;
        cx.notify();
        fetch(
            cx,
            move |client| async move {
                let body = json!({"api_key": api_key, "verify": true});
                client.replace_credential(&id, &body).await
            },
            move |this: &mut Self, result: Result<Value, Error>, cx| {
                if result.is_err() {
                    this.keys.check = Check::Failed;
                    return;
                }
                this.end_replace();
                let words = Self::words(cx);
                let message = super::copy::Words::fill(words.replaced_status, &name);
                announce(&mut this.keys.toast, Toast::success(message), cx);
                this.refresh_keys(cx);
            },
        );
    }

    /// `useSavedKeys.remove`: asks first; the default model's key is never deleted.
    pub(super) fn begin_delete(&mut self, id: &str, cx: &mut Context<Self>) {
        let Load::Ready(list) = &self.keys.list else {
            return;
        };
        let Some(key) = list.iter().find(|key| key.id == id) else {
            return;
        };
        let words = Self::words(cx);
        let name = self.key_name(key, cx);
        let (message, force) = match self.delete_rule(key, cx) {
            Rule::Blocked => return,
            Rule::Force(count) => (words.delete_confirm_models(&name, count), true),
            Rule::Plain => (super::copy::Words::fill(words.delete_confirm, &name), false),
        };
        let request = Request::new(message)
            .title(words.delete)
            .confirm_label(words.delete)
            .destructive();
        let (this, id) = (cx.entity(), id.to_owned());
        self.ctx.confirm(
            request,
            move |_, cx| this.update(cx, |this, cx| this.run_delete(id, name, force, cx)),
            cx,
        );
    }

    fn run_delete(&mut self, id: String, name: String, force: bool, cx: &mut Context<Self>) {
        self.keys.busy = Some(id.clone());
        cx.notify();
        fetch(
            cx,
            move |client| async move { client.delete_credential(&id, force.then_some(true)).await },
            move |this: &mut Self, result: Result<Value, Error>, cx| {
                this.keys.busy = None;
                let words = Self::words(cx);
                let toast = match result {
                    Ok(_) => Toast::success(super::copy::Words::fill(words.deleted_status, &name)),
                    Err(_) => Toast::error(words.delete_error),
                };
                announce(&mut this.keys.toast, toast, cx);
                this.refresh_keys(cx);
            },
        );
    }
}
