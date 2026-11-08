//! `MemoryModelPreparation`: the same memory-model choice as the first run, with its download
//! state read from the agent's setup readiness.
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::context::Lang;
use butler_ds::ui::toast::Toast;
use butler_ds::ui::typo::{Tone, Typo};
use butler_shell_client::Error;
use gpui::{Context, ParentElement as _};
use serde_json::json;

use super::copy::{Words, words};
use super::format::memory_model_description;
use super::types::{MemoryModel, Readiness};
use super::{MemoryPage, lang, later};
use crate::ui::settings::controls::SettingsSwitch;
use crate::ui::settings::state::fetch;

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
            && self.model.as_ref().is_none_or(|model| {
                matches!(model.state.as_str(), "unset" | "off" | "ready" | "failed")
            })
    }

    /// `memoryModelChoice(model) === "on"`
    fn chosen(&self) -> bool {
        self.model
            .as_ref()
            .is_some_and(|model| !matches!(model.state.as_str(), "unset" | "off"))
    }
}

impl MemoryPage {
    /// Reads the setup readiness, again every [`super::POLL`] until the memory model settles.
    pub(super) fn poll_model(&mut self, cx: &mut Context<Self>) {
        if self.model.polling {
            return;
        }
        self.model.polling = true;
        fetch(
            cx,
            |client| async move { client.get_setup_readiness().await },
            |this: &mut Self, result: Result<Readiness, Error>, cx| {
                this.model.polling = false;
                if let Ok(view) = result {
                    this.model.loaded = true;
                    this.model.model = view.memory_model;
                }
                if !this.model.settled() {
                    later(cx, super::MemoryPage::poll_model);
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
            |this: &mut Self, result: Result<Readiness, Error>, cx| {
                this.model.saving = false;
                match result {
                    Ok(view) => {
                        this.model.loaded = true;
                        this.model.model = view.memory_model;
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
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "whole megabytes of a download"
        )]
        let size_mb = model
            .filter(|model| model.bytes_total > 0 && model.state != "ready")
            .map(|model| (model.bytes_total as f64 / 1_000_000.0).round() as u64);
        let page = cx.weak_entity();
        let mut switch = SettingsSwitch::new("memory-model", copy.memory_choice_on)
            .description(memory_model_description(size_mb, lang))
            .checked(self.model.chosen())
            .disabled(model.is_none() || self.model.saving)
            .on_change(move |enabled, _, cx| {
                let _ = page.update(cx, |this, cx| this.choose_memory_model(enabled, cx));
            });
        if model.is_some_and(|model| model.state == "ready") {
            switch =
                switch.after_control(Typo::caption(copy.memory_model_ready).tone(Tone::Success));
        }
        // CARVE-OUT(G-onboard): `first-run/MemoryModelStatus`, the download progress, the failure
        // reason and its Retry, which React shows under the switch while the model is not ready.
        SettingsSection::new(
            "memory-model",
            SettingsSectionKind::Form,
            copy.memory_model_label,
        )
        .child(switch)
    }
}
