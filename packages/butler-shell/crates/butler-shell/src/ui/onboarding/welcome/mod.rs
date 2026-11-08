//! Welcome and consent (`FirstRunWelcome`, `FirstRunConsent`, `useWelcomeConsent`): the consent
//! controller and the two screens.
mod agreement;
mod copy;
mod start;

use std::rc::Rc;

use butler_ds::ui::context::Lang;
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::Error;
use chrono::{SecondsFormat, Utc};
use gpui::{Context, EventEmitter, SharedString};
use serde_json::{Map, Value, json};

pub(crate) use agreement::consent_screen;
pub(crate) use start::screen;

use super::gate::consent_accepted_patch;
use crate::ui::onboarding::words;
use crate::ui::settings::state::fetch;

/// The consent was saved; the Agent's settings after the PATCH.
pub(crate) enum ConsentEvent {
    Agreed(Rc<Value>),
}

/// `useWelcomeConsent`: the accepted time and the consent PATCH.
pub(crate) struct Consent {
    accepted_at: Option<SharedString>,
    saving: bool,
}

impl EventEmitter<ConsentEvent> for Consent {}

/// The language code the settings store (`FirstRunLanguage`).
fn language_code(lang: Lang) -> &'static str {
    match lang {
        Lang::Ko => "ko",
        Lang::En => "en",
    }
}

/// `{...current, ...patch, ...saved, language}`
fn merged(current: Value, patch: &Value, saved: &Value, language: &str) -> Value {
    let mut settings = match current {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    for layer in [patch, saved] {
        if let Some(layer) = layer.as_object() {
            settings.extend(
                layer
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone())),
            );
        }
    }
    settings.insert("language".into(), Value::from(language));
    Value::Object(settings)
}

impl Consent {
    pub(crate) fn new(cx: &mut Context<Self>) -> Self {
        let _ = cx;
        Self {
            accepted_at: None,
            saving: false,
        }
    }

    pub(crate) fn accepted_at(&self) -> Option<SharedString> {
        self.accepted_at.clone()
    }

    pub(crate) fn saving(&self) -> bool {
        self.saving
    }

    /// Saves the consent (`consentAcceptedPatch`), then emits [`ConsentEvent::Agreed`].
    pub(crate) fn agree(&mut self, lang: Lang, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        self.saving = true;
        cx.notify();
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let language = language_code(lang);
        let accepted_at = now.clone();
        fetch(
            cx,
            move |client| async move {
                let current = client.get_settings().await?;
                let onboarding = current.get("onboarding").unwrap_or(&Value::Null);
                let mut patch = consent_accepted_patch(onboarding, &now);
                patch["language"] = json!(language);
                let saved = client.update_settings(&patch).await?;
                Ok(merged(current, &patch, &saved, language))
            },
            move |this: &mut Self, result: Result<Value, Error>, cx| {
                this.saving = false;
                match result {
                    Ok(settings) => {
                        this.accepted_at = Some(accepted_at.into());
                        cx.emit(ConsentEvent::Agreed(Rc::new(settings)));
                    }
                    Err(_) => {
                        toast::show(cx, Toast::error(words(lang).finish_failed));
                    }
                }
            },
        );
    }

    /// Declining forgets this session's acceptance.
    pub(crate) fn clear(&mut self, cx: &mut Context<Self>) {
        self.accepted_at = None;
        cx.notify();
    }
}
