//! The settings fields of the page: `ProactiveFields`, `RecallSettings` and
//! `ButlerConsolidationSettings` (through `MemoryCleanupFields`). Each saves with
//! `update(partial, setSettings)`: not optimistic, with the Saved toast.
use std::rc::Rc;

use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::context::Lang;
use butler_ds::ui::layout::{Inline, Space};
use butler_ds::ui::segmented_control::{Choice, SegmentedControl};
use butler_ds::ui::time_picker::TimePicker;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _};
use serde_json::{Map, Value};

use super::MemoryPage;
use super::copy::Words;
use super::format::token_window_label;
use super::types::MemorySettings;
use crate::ui::composer::decode_catalog;
use crate::ui::composer::menus::{ModelChoice, model_display_name};
use crate::ui::composer::queue::effort_wire;
use crate::ui::settings::controls::{
    ReasoningSelect, SettingsOption, SettingsSelect, provider_mark,
};
use crate::ui::settings::{Save, SectionCtx};
use crate::ui::source::wire::ReasoningEffort;

/// `update({ key: value })`
fn save(ctx: &SectionCtx, key: &str, value: impl Into<Value>, cx: &mut App) {
    let mut patch = Map::new();
    patch.insert(key.to_owned(), value.into());
    ctx.save(Value::Object(patch), Save::default(), cx);
}

impl MemoryPage {
    pub(super) fn proactive_fields(&self, copy: &Words, lang: Lang, cx: &App) -> Vec<AnyElement> {
        let state = self.ctx.state.read(cx);
        let settings = state.slice::<MemorySettings>();
        let disabled = settings.is_none() || state.saving();
        let settings = settings.unwrap_or_default();
        let level = settings
            .proactive_level
            .unwrap_or_else(|| "sometimes".to_owned());
        let choices = [
            ("off", copy.proactive_off),
            ("sometimes", copy.proactive_sometimes),
            ("often", copy.proactive_often),
        ]
        .map(|(value, label)| {
            let choice = Choice::new(value, label);
            if disabled { choice.disabled() } else { choice }
        });
        let ctx = self.ctx.clone();
        let level_control =
            SegmentedControl::new("proactive-level-control", copy.proactive_level, level)
                .options(choices)
                .on_value_change(move |value, _, cx| save(&ctx, "proactive_level", value, cx));
        let time = |id: &'static str, key: &'static str, value: String| {
            let ctx = self.ctx.clone();
            TimePicker::new(id, value, copy.pick_time)
                .locale(lang)
                .disabled(disabled)
                .on_value_change(move |value, _, cx| save(&ctx, key, value.to_string(), cx))
        };
        let quiet = Inline::new()
            .gap(Space::Xs)
            .wrap(false)
            .child(time(
                "quiet-hours-start",
                "quiet_hours_start",
                settings
                    .quiet_hours_start
                    .unwrap_or_else(|| "22:00".to_owned()),
            ))
            .child(Typo::body("–").tone(Tone::Secondary))
            .child(time(
                "quiet-hours-end",
                "quiet_hours_end",
                settings
                    .quiet_hours_end
                    .unwrap_or_else(|| "07:00".to_owned()),
            ));
        vec![
            SettingsField::new(copy.proactive_level)
                .description(copy.proactive_description)
                .control(level_control)
                .setting_id("proactive-level")
                .into_any_element(),
            SettingsField::new(copy.quiet_hours)
                .description(copy.quiet_hours_description)
                .control(quiet)
                .setting_id("quiet-hours")
                .into_any_element(),
        ]
    }

    /// The registered models that are ready (`runtimeModels(catalog)` filtered to `registered`).
    fn registered_models(&self, cx: &App) -> Vec<ModelChoice> {
        let state = self.ctx.state.read(cx);
        let registered = state
            .catalog()
            .and_then(decode_catalog)
            .and_then(|catalog| catalog.registered_models)
            .unwrap_or_default();
        registered
            .into_iter()
            .filter(|model| {
                model.runtime_supported && model.availability.as_deref() == Some("ready")
            })
            .collect()
    }

    pub(super) fn recall_fields(&self, copy: &Words, cx: &App) -> Vec<AnyElement> {
        let Some(settings) = self.ctx.state.read(cx).slice::<MemorySettings>() else {
            return Vec::new();
        };
        let saving = self.ctx.state.read(cx).saving();
        let [label, description, faster, accurate, model_label, same] = copy.recall;
        let mode = settings.recall_mode.unwrap_or_else(|| "faster".to_owned());
        let ctx = self.ctx.clone();
        let mut fields = vec![
            SettingsSelect::new("recall-mode", label, mode.clone())
                .description(description)
                .disabled(saving)
                .options(vec![
                    SettingsOption::new("faster", faster),
                    SettingsOption::new("accurate", accurate),
                ])
                .on_change(move |value, _, cx| save(&ctx, "recall_mode", value.to_string(), cx))
                .into_any_element(),
        ];
        if mode == "accurate" {
            let mut options = vec![SettingsOption::new("default", same)];
            options.extend(self.registered_models(cx).iter().map(|model| {
                SettingsOption::new(
                    model.model_ref.clone(),
                    format!("{} / {}", model.provider_label, model_display_name(model)),
                )
            }));
            let ctx = self.ctx.clone();
            fields.push(
                SettingsSelect::new(
                    "recall-judge-model",
                    model_label,
                    settings
                        .recall_judge_model
                        .unwrap_or_else(|| "default".to_owned()),
                )
                .disabled(saving)
                .options(options)
                .on_change(move |value, _, cx| {
                    save(&ctx, "recall_judge_model", value.to_string(), cx);
                })
                .into_any_element(),
            );
        }
        fields
    }

    /// The consolidation model and its reasoning.
    pub(super) fn consolidation_model_fields(
        &self,
        copy: &Words,
        lang: Lang,
        cx: &App,
    ) -> Vec<AnyElement> {
        let state = self.ctx.state.read(cx);
        let Some(settings) = state.slice::<MemorySettings>() else {
            return Vec::new();
        };
        let models = state.runtime_models();
        let active = models
            .iter()
            .find(|model| Some(&*model.model_ref) == settings.model.as_deref())
            .or(models.first());
        let chosen = settings
            .consolidation_model
            .unwrap_or_else(|| "default".to_owned());
        let model = if chosen == "default" {
            active
        } else {
            models
                .iter()
                .find(|model| &*model.model_ref == chosen.as_str())
                .or(active)
        };
        let mut default = SettingsOption::new("default", copy.consolidation_model_default);
        default.description = Some(copy.consolidation_model_default_description.into());
        let mut options = vec![default];
        options.extend(models.iter().map(|choice| {
            let mut option = SettingsOption::new(
                choice.model_ref.clone(),
                format!(
                    "{} / {} ({})",
                    choice.provider_label,
                    model_display_name(choice),
                    token_window_label(choice.context_window_tokens, lang)
                ),
            );
            let (provider, platform) = (choice.provider_id.clone(), choice.platform.clone());
            option.icon = Some(Rc::new(move || {
                provider_mark(&provider, platform.as_deref(), false)
            }));
            option
        }));
        let (select_ctx, reasoning_ctx) = (self.ctx.clone(), self.ctx.clone());
        let select = SettingsSelect::new("consolidation-model", copy.consolidation_model, chosen)
            .description(copy.consolidation_model_description)
            .options(options)
            .on_change(move |value, _, cx| {
                save(&select_ctx, "consolidation_model", value.to_string(), cx);
            });
        let reasoning = ReasoningSelect::new(
            "consolidation-reasoning",
            copy.reasoning,
            model,
            settings
                .consolidation_reasoning_effort
                .unwrap_or(ReasoningEffort::None),
        )
        .on_change(move |effort, _, cx| {
            if let Some(effort) = effort_wire(effort) {
                save(&reasoning_ctx, "consolidation_reasoning_effort", effort, cx);
            }
        });
        vec![select.into_any_element(), reasoning.into_any_element()]
    }
}
