//! `MemoryModelPreparation`: the same memory-model choice as the first run, with its download
//! state read from the agent's setup readiness.
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::context::Lang;
use butler_ds::ui::toast::Toast;
use butler_ds::ui::typo::{Tone, Typo};
use butler_shell_client::Error;
use gpui::{Context, ParentElement as _};
use serde_json::{Value, json};
use std::rc::Rc;

use super::copy::{Words, words};
use super::format::memory_model_description;
use super::{MemoryPage, lang, later};
use crate::ui::onboarding::memory::status::{Retry, megabytes, memory_status, parse};
use crate::ui::onboarding::readiness::MemoryModel;
use crate::ui::settings::controls::SettingsSwitch;
use crate::ui::settings::state::{fetch, fetch_if};

#[derive(Default)]
pub(super) struct ModelPrep {
    /// A readiness view has been read (`view !== null`).
    loaded: bool,
    model: Option<MemoryModel>,
    saving: bool,
    polling: bool,
}

impl ModelPrep {
    /// `settled`: chosen and nothing more will change without the owner.
    fn settled(&self) -> bool {
        self.loaded
            && self
                .model
                .as_ref()
                .is_none_or(|model| matches!(&*model.state, "unset" | "off" | "ready" | "failed"))
    }

    /// `memoryModelChoice(model) === "on"`
    fn chosen(&self) -> bool {
        self.model
            .as_ref()
            .is_some_and(|model| !matches!(&*model.state, "unset" | "off"))
    }
}

impl MemoryPage {
    /// Reads the setup readiness, again every [`super::POLL`] until the memory model settles.
    pub(super) fn poll_model(&mut self, cx: &mut Context<Self>) {
        if self.model.polling {
            return;
        }
        self.model.polling = true;
        fetch_if(
            cx,
            |client| async move { client.get_setup_readiness().await },
            |this: &mut Self, result: Result<Value, Error>, cx| {
                this.model.polling = false;
                let mut changed = false;
                if let Ok(view) = result {
                    let model = view.get("memory_model").and_then(parse);
                    changed = !this.model.loaded || this.model.model != model;
                    this.model.loaded = true;
                    this.model.model = model;
                }
                if !this.model.settled() {
                    later(cx, super::MemoryPage::poll_model);
                }
                changed
            },
        );
    }

    /// `MemoryModelStatus`'s Retry: POST /setup/readiness/retry `{memory_model_only: true}`, then
    /// the poll follows the new download.
    fn retry_model(cx: &mut Context<Self>) {
        let body = json!({ "memory_model_only": true });
        fetch(
            cx,
            move |client| async move { client.retry_setup_readiness(&body).await },
            |this: &mut Self, result: Result<Value, Error>, cx| {
                if let Ok(view) = result {
                    this.model.loaded = true;
                    this.model.model = view.get("memory_model").and_then(parse);
                }
                if !this.model.settled() {
                    this.poll_model(cx);
                }
            },
        );
    }

    /// `choose`: POST /setup/memory-model.
    fn choose_memory_model(&mut self, enabled: bool, cx: &mut Context<Self>) {
        self.model.saving = true;
        let body = json!({ "enabled": enabled });
        fetch(
            cx,
            move |client| async move { client.choose_memory_model(&body).await },
            |this: &mut Self, result: Result<Value, Error>, cx| {
                this.model.saving = false;
                match result {
                    Ok(view) => {
                        this.model.loaded = true;
                        this.model.model = view.get("memory_model").and_then(parse);
                        if !this.model.settled() {
                            this.poll_model(cx);
                        }
                    }
                    Err(_) => {
                        let copy = words(lang(cx));
                        this.notify(
                            "memory-model-choice",
                            Toast::error(copy.memory_choice_save_failed),
                            cx,
                        );
                    }
                }
            },
        );
    }

    pub(super) fn model_section(
        &self,
        copy: &Words,
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let model = self.model.model.as_ref();
        let size_mb = model
            .filter(|model| model.bytes_total > 0 && &*model.state != "ready")
            .map(|model| megabytes(model.bytes_total));
        let page = cx.weak_entity();
        let retry_page = page.clone();
        let mut switch = SettingsSwitch::new("memory-model", copy.memory_choice_on)
            .description(memory_model_description(size_mb, lang))
            .checked(self.model.chosen())
            .disabled(model.is_none() || self.model.saving)
            .on_change(move |enabled, _, cx| {
                let _ = page.update(cx, |this, cx| this.choose_memory_model(enabled, cx));
            });
        if model.is_some_and(|model| &*model.state == "ready") {
            switch =
                switch.after_control(Typo::caption(copy.memory_model_ready).tone(Tone::Success));
        }
        let retry: Retry = Rc::new(move |_, cx| {
            let _ = retry_page.update(cx, |_, cx| super::MemoryPage::retry_model(cx));
        });
        let mut section = SettingsSection::new(
            "memory-model",
            SettingsSectionKind::Form,
            copy.memory_model_label,
        )
        .child(switch);
        if let Some(status) = memory_status(self.model.model.as_ref(), lang, retry) {
            section = section.child(status);
        }
        section
    }
}
