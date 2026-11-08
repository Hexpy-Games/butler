//! ③ the reply language (`FirstRunReplyLanguage`, `useReplyLanguage`): `GET/PATCH
//! /personalization`, and the completion of the onboarding.
use std::rc::Rc;

use butler_ds::ui::blocks::setup_wizard_step_card::SetupWizardStepAction;
use butler_ds::ui::context::Lang;
use butler_ds::ui::field::{Field, FieldLabel};
use butler_ds::ui::native_select::NativeSelect;
use butler_ds::ui::typo::{Tone, Typo};
use butler_shell_client::{Error, ShellClient};
use chrono::{SecondsFormat, Utc};
use gpui::{
    AnyElement, Context, EventEmitter, IntoElement as _, ParentElement as _, SharedString, Window,
};
use serde_json::{Map, Value, json};

use super::code;
use super::copy::words;
use crate::ui::onboarding::copy::words as shared;
use crate::ui::onboarding::gate::CONSENT_VERSION;
use crate::ui::onboarding::{Onboarding, card::step_card, readiness};
use crate::ui::settings::state::fetch;

/// The reply language was saved (`Saved`), or the onboarding was completed with these
/// settings (`Completed`).
pub(crate) enum ReplyEvent {
    Saved,
    Completed(Rc<Value>),
}

pub(crate) struct Reply {
    /// The agent's reply language, once read.
    value: Option<Lang>,
    saving: bool,
    failed: bool,
    loading: bool,
    /// Bumped when the connection goes away, so an old read is dropped.
    epoch: u64,
}

impl EventEmitter<ReplyEvent> for Reply {}

fn parse(view: &Value) -> Option<Lang> {
    match view.get("response_language").and_then(Value::as_str) {
        Some("ko") => Some(Lang::Ko),
        Some("en") => Some(Lang::En),
        _ => None,
    }
}

/// `onboardingCompletedPatch` over the agent's current settings, then the PATCH; the settings
/// as `{...current, ...patch, ...saved}`.
async fn complete_call(
    client: ShellClient,
    language: &'static str,
    accepted_at: Option<String>,
) -> Result<Value, Error> {
    let current = client.get_settings().await?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut onboarding = current
        .get("onboarding")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let accepted = onboarding
        .get("accepted_at")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or(accepted_at)
        .unwrap_or_else(|| now.clone());
    onboarding.insert("consent_version".into(), CONSENT_VERSION.into());
    onboarding.insert("accepted_at".into(), accepted.into());
    onboarding.insert("completed_at".into(), now.into());
    let patch = json!({"language": language, "onboarding": onboarding});
    let saved = client.update_settings(&patch).await?;
    let mut merged: Map<String, Value> = current.as_object().cloned().unwrap_or_default();
    if let Value::Object(patch) = patch {
        merged.extend(patch);
    }
    if let Value::Object(saved) = saved {
        merged.extend(saved);
    }
    Ok(Value::Object(merged))
}

impl Reply {
    pub(crate) fn new(cx: &mut Context<Self>) -> Self {
        let _ = cx;
        Self {
            value: None,
            saving: false,
            failed: false,
            loading: false,
            epoch: 0,
        }
    }

    pub(crate) fn value(&self) -> Option<Lang> {
        self.value
    }

    pub(crate) fn saving(&self) -> bool {
        self.saving
    }

    pub(crate) fn failed(&self) -> bool {
        self.failed
    }

    /// Reads the reply language once a connection is live (the screen calls it each render; it
    /// reads once, and its answer re-renders).
    fn ensure_loaded(&mut self, connected: bool, cx: &mut Context<Self>) {
        if !connected {
            if self.value.is_some() || self.loading || self.failed {
                self.epoch += 1;
                self.value = None;
                self.loading = false;
                self.failed = false;
            }
            return;
        }
        if self.value.is_some() || self.loading || self.failed {
            return;
        }
        self.loading = true;
        let epoch = self.epoch;
        fetch(
            cx,
            |client| async move { client.get_personalization().await },
            move |this: &mut Self, result: Result<Value, Error>, _| {
                if this.epoch != epoch {
                    return;
                }
                this.loading = false;
                match result.ok().as_ref().and_then(parse) {
                    Some(lang) => this.value = Some(lang),
                    None => this.failed = true,
                }
            },
        );
    }

    fn retry(&mut self, cx: &mut Context<Self>) {
        self.failed = false;
        cx.notify();
    }

    fn set_value(&mut self, value: &str, cx: &mut Context<Self>) {
        self.value = match value {
            "ko" => Some(Lang::Ko),
            "en" => Some(Lang::En),
            _ => self.value,
        };
        cx.notify();
    }

    /// ③ Next: only the reply language; completion waits for the finish step.
    fn save(&mut self, cx: &mut Context<Self>) {
        let Some(value) = self.value else { return };
        if self.saving {
            return;
        }
        self.saving = true;
        self.failed = false;
        cx.notify();
        let body = json!({"response_language": code(value)});
        fetch(
            cx,
            move |client| async move { client.update_personalization(&body).await },
            |this: &mut Self, result: Result<Value, Error>, cx| {
                this.saving = false;
                if result.is_ok() {
                    cx.emit(ReplyEvent::Saved);
                } else {
                    this.failed = true;
                }
            },
        );
    }

    /// Marks the onboarding complete (`onboardingCompletedPatch`), then emits
    /// [`ReplyEvent::Completed`].
    pub(crate) fn complete(
        &mut self,
        lang: Lang,
        accepted_at: Option<SharedString>,
        cx: &mut Context<Self>,
    ) {
        if self.saving {
            return;
        }
        self.saving = true;
        self.failed = false;
        cx.notify();
        let language = code(lang);
        let accepted_at = accepted_at.map(|at| at.to_string());
        fetch(
            cx,
            move |client| complete_call(client, language, accepted_at),
            |this: &mut Self, result: Result<Value, Error>, cx| {
                this.saving = false;
                match result {
                    Ok(settings) => cx.emit(ReplyEvent::Completed(Rc::new(settings))),
                    Err(_) => this.failed = true,
                }
            },
        );
    }
}

/// ③ the reply language.
pub(crate) fn reply_screen(
    view: &Onboarding,
    window: &mut Window,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let copy = words(view.lang);
    let common = shared(view.lang);
    let connected = view.commit.read(cx).connected().is_some();
    view.reply
        .update(cx, |reply, cx| reply.ensure_loaded(connected, cx));
    let (value, saving, failed) = {
        let reply = view.reply.read(cx);
        (reply.value, reply.saving, reply.failed)
    };
    let locked = value.is_none() || saving;

    let reply = view.reply.clone();
    let mut select = NativeSelect::new("first-run-reply-language")
        .stretch()
        .value(value.map_or("", code));
    if value.is_none() {
        select = select.option("", copy.connecting);
    }
    select = select
        .option("ko", "한국어")
        .option("en", "English")
        .on_change(move |chosen, _, cx| reply.update(cx, |reply, cx| reply.set_value(chosen, cx)));
    if locked {
        select = select.disabled();
    }
    let mut field = Field::new("first-run-reply-field")
        .child(FieldLabel::new().child(copy.reply_language))
        .child(select);
    if failed {
        field = field.child(Typo::caption(common.finish_failed).tone(Tone::Secondary));
    }

    let on_save = view.reply.clone();
    let mut next = SetupWizardStepAction::new("first-run-reply-next", copy.next)
        .forward()
        .on_click(move |_, _, cx| on_save.update(cx, Reply::save));
    if locked {
        next = next.disabled();
    }
    let mut card = step_card(view, copy.reply_title, [field.into_any_element()], cx)
        .content_key("reply")
        .description(copy.reply_body)
        .on_back(
            common.back,
            cx.listener(|view, _, window, cx| view.back_from_reply(window, cx)),
        );
    if !connected {
        card = card.footer_start(readiness::prep_status(view, window, cx));
    }
    if failed && value.is_none() {
        let on_retry = view.reply.clone();
        card = card.action(
            SetupWizardStepAction::new("first-run-reply-retry", common.retry)
                .on_click(move |_, _, cx| on_retry.update(cx, Reply::retry)),
        );
    }
    card.action(next).into_any_element()
}
