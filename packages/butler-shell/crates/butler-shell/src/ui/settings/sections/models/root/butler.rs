//! The Butler model section (`ButlerModelFields.tsx`, `ButlerPrimaryModelSelect.tsx`,
//! `useLocalReasoningBudget.tsx`): the primary model with Manage models, reasoning, the context
//! limit and the local reasoning budget.
use butler_ds::ui::blocks::percent_input_control::PercentInputControl;
use butler_ds::ui::blocks::settings_field::{ControlWidth, SettingsField};
use butler_ds::ui::blocks::settings_section::{
    SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::blocks::token_input_control::TokenInputControl;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::toast::{self, Toast, ToastId};
use butler_shell_client::Error;
use gpui::{App, Context, ParentElement as _};
use serde::Deserialize;
use serde_json::{Value, json};

use super::super::ModelRoute;
use super::RootPage;
use super::data::{
    Slice, grouped, local_model_payload, model_options, percent_to_ratio, ratio_to_percent,
    raw_model, whole,
};
use crate::ui::Icon;
use crate::ui::composer::menus::ModelChoice;
use crate::ui::composer::menus::model::model_choice;
use crate::ui::composer::menus::token_window_label;
use crate::ui::composer::queue::effort_wire;
use crate::ui::i18n::composer::menus::copy as composer_copy;
use crate::ui::i18n::settings::words as frame_words;
use crate::ui::settings::Save;
use crate::ui::settings::controls::{ReasoningSelect, SettingsSelect};
use crate::ui::settings::state::fetch;
use crate::ui::source::wire::ReasoningEffort;

/// `activeModelContextMax`'s fallback: `activeModel?.context_window_tokens ?? 200_000`.
const DEFAULT_CONTEXT_MAX: f64 = 200_000.;

/// The answer of PATCH /model-catalog/local-models/:ref (`LocalModelRegistrationResult`).
#[derive(Deserialize)]
struct Saved {
    model: SavedModel,
}

#[derive(Deserialize)]
struct SavedModel {
    model_ref: String,
    default_reasoning_effort: Option<String>,
}

/// Shows `next` in place of the toast kept in `slot`.
fn show(slot: &mut Option<ToastId>, next: Toast, cx: &mut App) {
    let next = match *slot {
        Some(id) => next.id(id),
        None => next,
    };
    *slot = Some(toast::show(cx, next));
}

/// The patch a new primary model leads to: the model, a reasoning effort it offers and a
/// context limit within its window.
fn primary_patch(
    models: &[ModelChoice],
    model_ref: &str,
    effort: &ReasoningEffort,
    tokens: f64,
    active_max: f64,
) -> Value {
    let next = models.iter().find(|model| &*model.model_ref == model_ref);
    let next_max = next
        .and_then(|model| model.context_window_tokens)
        .unwrap_or(tokens);
    let limit = if tokens >= active_max {
        next_max
    } else {
        tokens.min(next_max)
    };
    let effort = match next {
        Some(next) => model_choice(next, effort).1,
        None => ReasoningEffort::Medium,
    };
    json!({
        "model": model_ref,
        "reasoning_effort": effort_wire(&effort).unwrap_or("medium"),
        "context_window_tokens": whole(limit),
    })
}

impl RootPage {
    /// The `butler-model` section.
    pub(super) fn butler_section(&mut self, cx: &mut Context<Self>) -> SettingsSection {
        let words = super::copy::get(cx);
        let lang = Ds::get(cx).lang();
        let state = self.ctx.state.read(cx);
        let slice: Option<Slice> = state.slice();
        let (models, saving) = (state.runtime_models(), state.saving());
        let section = SettingsSection::new(
            "butler-model",
            SettingsSectionKind::Form,
            words.butler_model_section,
        );
        let Some(slice) = slice else {
            return section.state(SettingsSectionState::Loading);
        };
        let active = models
            .iter()
            .find(|model| *model.model_ref == *slice.model)
            .or_else(|| models.first())
            .cloned();
        let max = active
            .as_ref()
            .and_then(|model| model.context_window_tokens)
            .unwrap_or(DEFAULT_CONTEXT_MAX);
        let effort = slice
            .reasoning_effort
            .clone()
            .unwrap_or(ReasoningEffort::Medium);
        let primary = self.primary_select(
            &models,
            active.as_ref(),
            (&effort, slice.context_window_tokens, max),
            lang,
            cx,
        );
        let ctx = self.ctx.clone();
        let reasoning = ReasoningSelect::new("reasoning", words.reasoning, active.as_ref(), effort)
            .on_change(move |effort, _, cx| {
                if let Some(wire) = effort_wire(effort) {
                    ctx.save(json!({ "reasoning_effort": wire }), Save::default(), cx);
                }
            });
        let local = active
            .filter(|model| &*model.provider_id == "local")
            .filter(|model| !model.reasoning_efforts.contains(&ReasoningEffort::Low));
        let budget = local.map(|model| Self::budget_field(&model, saving, cx));
        section
            .child(primary)
            .child(reasoning)
            .child(self.context_field(slice.context_window_tokens, max, lang, cx))
            .children(budget)
    }

    /// `ButlerPrimaryModelSelect`; `limits` is the current effort, context limit and the active
    /// model's maximum.
    fn primary_select(
        &self,
        models: &[ModelChoice],
        active: Option<&ModelChoice>,
        limits: (&ReasoningEffort, f64, f64),
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> SettingsSelect {
        let words = super::copy::get(cx);
        let navigate = self.navigate.clone();
        let manage = Button::new("settings-model-management-button")
            .size(Size::Lg)
            .variant(Variant::Outline)
            .icon_start(icon(Icon::Settings, IconSize::Md, Ds::get(cx)))
            .text(words.manage_models)
            .on_click(move |_, window, cx| navigate(ModelRoute::Management, window, cx));
        let value = active.map_or_else(Default::default, |model| model.model_ref.clone());
        let (ctx, all) = (self.ctx.clone(), models.to_vec());
        let (effort, tokens, max) = (limits.0.clone(), limits.1, limits.2);
        SettingsSelect::new("primary-model", words.model, value)
            .options(model_options(models, lang))
            .description(words.runtime_models_only)
            .control_width(ControlWidth::Full)
            .action(manage)
            .on_change(move |value, _, cx| {
                let patch = primary_patch(&all, value, &effort, tokens, max);
                ctx.save(patch, Save::default(), cx);
            })
    }

    /// The context limit: a token input within the active model's window.
    fn context_field(
        &self,
        tokens: f64,
        max: f64,
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> SettingsField {
        let words = super::copy::get(cx);
        let (ctx, page) = (self.ctx.clone(), cx.entity());
        let control = TokenInputControl::new("context-limit", tokens, 1_000., max).on_commit(
            move |value, clamped, _, cx| {
                ctx.save(
                    json!({ "context_window_tokens": whole(value) }),
                    Save::default(),
                    cx,
                );
                if clamped {
                    page.update(cx, |page, cx| {
                        let text =
                            (super::copy::get(cx).context_limit_clamped)(&grouped(whole(value)));
                        show(&mut page.clamp_toast, Toast::success(text), cx);
                    });
                }
            },
        );
        SettingsField::new(words.context_limit)
            .description((words.context_limit_description)(&token_window_label(
                Some(max),
                composer_copy(lang),
            )))
            .control(control)
    }

    /// The local reasoning budget of the active local model.
    fn budget_field(model: &ModelChoice, saving: bool, cx: &mut Context<Self>) -> SettingsField {
        let words = super::copy::get(cx);
        let (page, model_ref) = (cx.entity(), model.model_ref.clone());
        let mut control = PercentInputControl::new(
            "local-reasoning-budget",
            ratio_to_percent(model.local_reasoning_budget_ratio),
        )
        .on_commit(move |percent, _, cx| {
            let model_ref = model_ref.clone();
            page.update(cx, |page, cx| page.update_budget(&model_ref, percent, cx));
            true
        });
        if saving {
            control = control.disabled();
        }
        SettingsField::new(words.local_reasoning_budget)
            .description(words.local_reasoning_budget_description)
            .control(control)
    }

    /// `updateActiveLocalReasoningBudget`
    fn update_budget(&mut self, model_ref: &str, percent: f64, cx: &mut Context<Self>) {
        let ratio = percent_to_ratio(percent);
        let catalog = self.ctx.state.read(cx).catalog();
        let Some(raw) = raw_model(catalog, model_ref) else {
            return;
        };
        let (body, model_ref) = (local_model_payload(raw, ratio), model_ref.to_owned());
        fetch(
            cx,
            move |client| async move { client.update_local_model(&model_ref, &body).await },
            move |this: &mut Self, result: Result<Saved, Error>, cx| {
                this.budget_saved(result, ratio, cx);
            },
        );
    }

    fn budget_saved(&mut self, result: Result<Saved, Error>, ratio: f64, cx: &mut Context<Self>) {
        let words = super::copy::get(cx);
        let notice = match result {
            Err(_) => Toast::error(words.update_local_budget_failed),
            Ok(saved) => {
                self.ctx.reload_catalog(cx);
                let settings: Option<Slice> = self.ctx.state.read(cx).slice();
                let unset = settings.is_some_and(|slice| {
                    slice.model == saved.model.model_ref
                        && slice.reasoning_effort == Some(ReasoningEffort::None)
                });
                if ratio > 0.
                    && unset
                    && let Some(effort) = saved.model.default_reasoning_effort
                {
                    let patch = json!({ "reasoning_effort": effort });
                    self.ctx.save(patch, Save::default(), cx);
                }
                Toast::success(frame_words(Ds::get(cx).lang()).saved)
            }
        };
        show(&mut self.budget_toast, notice, cx);
    }
}
