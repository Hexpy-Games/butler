//! Settings: Personalization (`PersonalizationSettings.tsx`, `PersonalizationProfileFields.tsx`,
//! `PersonalizationTextFields.tsx`, `PersonalizationProfilingSettings.tsx`,
//! `PersonalizationActions.tsx`). The personalization view and its draft live here, not in the
//! shared settings: React keeps them in `settingsUIStore` beside the settings.
mod agent_import;
mod copy;
mod draft;
mod migration;
mod options;

use butler_ds::ui::blocks::settings_field::{ControlWidth, SettingsField};
use butler_ds::ui::blocks::settings_section::{SettingsPage, SettingsSection, SettingsSectionKind};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::Justify;
use butler_ds::ui::text::{Input, Textarea};
use butler_ds::ui::toast::{self, Toast, ToastId};
use butler_shell_client::Error;
use gpui::prelude::FluentBuilder as _;
use gpui::{
    AnyView, App, AppContext as _, ClickEvent, Context, IntoElement, ParentElement as _, Render,
    SharedString, Subscription, Window,
};
use serde::Deserialize;

use self::agent_import::AgentImport;
use self::copy::{Words, eol_last_loaded, words};
use self::draft::{Draft, PROFILE_KEYS, Personalization, update_payload};
use self::migration::Migration;
use crate::ui::Icon;
use crate::ui::composer::menus::ModelChoice;
use crate::ui::settings::controls::{ReasoningSelect, SettingsOption, SettingsSelect};
use crate::ui::settings::state::fetch;
use crate::ui::settings::{SectionCtx, SectionId};
use crate::ui::source::wire::ReasoningEffort;

/// The settings fields this page reads: the Butler model and the app language.
#[derive(Deserialize)]
struct Core {
    model: Option<String>,
    language: Option<String>,
}

/// Shows `toast` in place of the one this slot last showed (React's toast `id`).
fn notify(slot: &mut Option<ToastId>, toast: Toast, cx: &mut App) {
    let toast = match *slot {
        Some(id) => toast.id(id),
        None => toast,
    };
    *slot = Some(toast::show(cx, toast));
}

/// `new Date(value).toLocaleString()`, close to the app language's own format.
fn loaded_at(updated_at: &str, lang: Lang) -> Option<String> {
    let at = chrono::DateTime::parse_from_rfc3339(updated_at)
        .ok()?
        .with_timezone(&chrono::Local);
    // Both locales default to a 12-hour clock; Korean names the half of the day first.
    Some(match lang {
        Lang::Ko => {
            let half = if at.format("%p").to_string() == "PM" {
                "오후"
            } else {
                "오전"
            };
            format!(
                "{} {half} {}",
                at.format("%Y. %-m. %-d."),
                at.format("%-I:%M:%S")
            )
        }
        Lang::En => at.format("%-m/%-d/%Y, %-I:%M:%S %p").to_string(),
    })
}

struct PersonalizationPage {
    ctx: SectionCtx,
    /// `settingsUIStore.personalization`: `None` until the read lands.
    personalization: Option<Personalization>,
    /// `settingsUIStore.personalizationDraft`
    draft: Draft,
    /// `settingsUIStore.saving`, for this page's own saves.
    saving: bool,
    /// The `personalization-update` toast.
    update_toast: Option<ToastId>,
    /// The `profile-migration` toast.
    migration_toast: Option<ToastId>,
    migration: Migration,
    import: AgentImport,
    _state: Subscription,
}

pub(crate) fn page(ctx: SectionCtx, _window: &mut Window, cx: &mut App) -> AnyView {
    cx.new(|cx| PersonalizationPage::new(ctx, cx)).into()
}

impl PersonalizationPage {
    fn new(ctx: SectionCtx, cx: &mut Context<Self>) -> Self {
        let state = cx.observe(&ctx.state, |_, _, cx| cx.notify());
        let page = Self {
            ctx,
            personalization: None,
            draft: Draft::default(),
            saving: false,
            update_toast: None,
            migration_toast: None,
            migration: Migration::default(),
            import: AgentImport::default(),
            _state: state,
        };
        Self::load(cx);
        Self::load_sources(cx);
        page
    }

    /// GET /personalization, as the store's `initialize`.
    fn load(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.get_personalization().await },
            |this: &mut Self, result: Result<Personalization, Error>, cx| match result {
                Ok(view) => {
                    this.draft = Draft::from(&view);
                    this.personalization = Some(view);
                }
                Err(_) => {
                    let copy = words(Ds::get(cx).lang());
                    toast::show(cx, Toast::error(copy.err_load));
                }
            },
        );
    }

    /// `savePersonalization`
    fn save(&mut self, cx: &mut Context<Self>) {
        let Some(view) = &self.personalization else {
            return;
        };
        let payload = update_payload(view, &self.draft);
        self.saving = true;
        cx.notify();
        fetch(
            cx,
            move |client| async move { client.update_personalization(&payload).await },
            |this: &mut Self, result: Result<Personalization, Error>, cx| {
                this.saving = false;
                let lang = Ds::get(cx).lang();
                let toast = match result {
                    Ok(saved) => {
                        this.draft = Draft::from(&saved);
                        this.personalization = Some(saved);
                        Toast::success(crate::ui::i18n::settings::words(lang).saved)
                    }
                    Err(_) => Toast::error(words(lang).err_update),
                };
                notify(&mut this.update_toast, toast, cx);
            },
        );
    }

    /// This page's saves or any settings save in flight.
    fn busy(&self, cx: &App) -> bool {
        self.saving || self.ctx.state.read(cx).saving()
    }

    fn language(&self, cx: &App) -> Option<String> {
        self.ctx.state.read(cx).slice::<Core>()?.language
    }

    /// `PersonalizationProfileFields`
    fn profile_section(
        &self,
        copy: &Words,
        disabled: bool,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let mut section =
            SettingsSection::new("profile", SettingsSectionKind::Form, copy.section_profile);
        for (index, key) in PROFILE_KEYS.into_iter().enumerate() {
            let id = SharedString::from(format!("personalization-profile-{key}"));
            let input = Input::new(id)
                .value(self.draft.profile[index].clone())
                .placeholder(copy.profile_placeholders[index])
                .when(disabled, Input::disabled)
                .on_change(cx.listener(move |this, value: &str, _, cx| {
                    value.clone_into(&mut this.draft.profile[index]);
                    cx.notify();
                }));
            section = section.child(
                SettingsField::new(copy.profile_labels[index])
                    .setting_id(SharedString::from(key.replace('_', "-")))
                    .control(input),
            );
        }
        section
    }

    /// `PersonalizationTextFields`
    fn text_fields(&self, copy: &Words, lang: Lang, cx: &mut Context<Self>) -> [SettingsField; 2] {
        let persona = Textarea::new("personalization-persona")
            .value(self.draft.persona.clone())
            .placeholder(copy.persona_placeholder)
            .rows(8)
            .on_change(cx.listener(|this, value: &str, _, cx| {
                value.clone_into(&mut this.draft.persona);
                "custom".clone_into(&mut this.draft.persona_preset);
                cx.notify();
            }));
        let eol = Textarea::new("personalization-eol")
            .value(self.draft.eol.clone())
            .placeholder(copy.eol_placeholder)
            .rows(8)
            .on_change(cx.listener(|this, value: &str, _, cx| {
                value.clone_into(&mut this.draft.eol);
                cx.notify();
            }));
        let mut eol_field = SettingsField::new(copy.eol)
            .setting_id("eol")
            .control_width(ControlWidth::Full)
            .control(eol);
        let loaded = self
            .personalization
            .as_ref()
            .and_then(|view| loaded_at(&view.updated_at, lang));
        if let Some(loaded) = loaded {
            eol_field = eol_field.meta_text(eol_last_loaded(lang, &loaded));
        }
        [
            SettingsField::new(copy.persona)
                .setting_id("persona")
                .control_width(ControlWidth::Full)
                .control(persona),
            eol_field,
        ]
    }

    fn response_style_section(
        &self,
        copy: &Words,
        lang: Lang,
        disabled: bool,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let presets = self
            .personalization
            .as_ref()
            .map(|view| view.persona_presets.as_slice())
            .unwrap_or_default();
        let language = SettingsSelect::new(
            "response-language",
            copy.response_language,
            self.draft.response_language.clone(),
        )
        .description(copy.response_language_description)
        .control_width(ControlWidth::Full)
        .options(vec![
            SettingsOption::new("en", copy.english),
            SettingsOption::new("ko", copy.korean),
        ])
        .disabled(disabled)
        .on_change(cx.listener(|this, value: &SharedString, _, cx| {
            let language = if &**value == "ko" { "ko" } else { "en" };
            language.clone_into(&mut this.draft.response_language);
            cx.notify();
        }));
        let preset = SettingsSelect::new(
            "persona-preset",
            copy.persona_preset,
            self.draft.persona_preset.clone(),
        )
        .description(copy.persona_preset_description)
        .control_width(ControlWidth::Full)
        .options(options::persona_presets(presets, copy))
        .disabled(disabled)
        .on_change(cx.listener(|this, value: &SharedString, _, cx| {
            if let Some(view) = &this.personalization {
                this.draft.select_preset(&view.persona_presets, value);
            }
            cx.notify();
        }));
        let [persona, eol] = self.text_fields(copy, lang, cx);
        SettingsSection::new(
            "response-style",
            SettingsSectionKind::Form,
            copy.section_response_style,
        )
        .child(language)
        .child(preset)
        .child(persona)
        .child(eol)
    }

    /// The mode, model and reasoning selects of the learning section.
    fn profiling_selects(
        &self,
        copy: &Words,
        lang: Lang,
        disabled: bool,
        cx: &mut Context<Self>,
    ) -> (SettingsSelect, SettingsSelect, ReasoningSelect) {
        let models: Vec<ModelChoice> = self.ctx.state.read(cx).runtime_models();
        let configured = self
            .ctx
            .state
            .read(cx)
            .slice::<Core>()
            .and_then(|core| core.model);
        let butler = models
            .iter()
            .find(|model| configured.as_deref() == Some(&*model.model_ref))
            .or_else(|| models.first());
        let extractor = if self.draft.extractor_model == "default" {
            butler
        } else {
            models
                .iter()
                .find(|model| *model.model_ref == *self.draft.extractor_model)
                .or(butler)
        };
        let mode = SettingsSelect::new(
            "profiling-mode",
            copy.profiling_mode,
            self.draft.mode.clone(),
        )
        .description(copy.profiling_mode_description)
        .control_width(ControlWidth::Full)
        .options(options::profiling_modes(copy))
        .disabled(disabled)
        .on_change(cx.listener(|this, value: &SharedString, _, cx| {
            let mode = match &**value {
                mode @ ("basic" | "deep") => mode,
                _ => "off",
            };
            mode.clone_into(&mut this.draft.mode);
            cx.notify();
        }));
        let model = SettingsSelect::new(
            "profiling-model",
            copy.extractor_model,
            self.draft.extractor_model.clone(),
        )
        .description(copy.extractor_model_description)
        .control_width(ControlWidth::Full)
        .options(options::extractor_models(&models, copy, lang))
        .disabled(disabled)
        .on_change(cx.listener(|this, value: &SharedString, _, cx| {
            this.draft.extractor_model = if value.is_empty() {
                "default".to_owned()
            } else {
                value.to_string()
            };
            cx.notify();
        }));
        let reasoning = ReasoningSelect::new(
            "profiling-reasoning",
            copy.reasoning,
            extractor,
            self.draft.effort.clone(),
        )
        .disabled(disabled)
        .on_change(cx.listener(|this, effort: &ReasoningEffort, _, cx| {
            this.draft.effort = effort.clone();
            cx.notify();
        }));
        (mode, model, reasoning)
    }

    /// `PersonalizationProfilingSettings`
    fn learning_section(
        &self,
        copy: &Words,
        lang: Lang,
        disabled: bool,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let (mode, model, reasoning) = self.profiling_selects(copy, lang, disabled, cx);
        let open_memory = Button::new("memory-link-open")
            .size(Size::Sm)
            .variant(Variant::Outline)
            .text(copy.memory_link_open)
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                this.ctx.open_section(SectionId::Memory, cx);
            }));
        SettingsSection::new("learning", SettingsSectionKind::Form, copy.section_learning)
            .description(copy.section_learning_description)
            .child(mode)
            .child(model)
            .child(reasoning)
            .child(
                SettingsField::new(copy.memory_link)
                    .setting_id("memory-link")
                    .description(copy.memory_link_description)
                    .control(open_memory),
            )
    }

    /// `PersonalizationActions`
    fn footer(&self, copy: &Words, busy: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let changed = self
            .personalization
            .as_ref()
            .is_some_and(|view| self.draft != Draft::from(view));
        button::container(Size::Default)
            .justify(Justify::End)
            .child(
                Button::new("personalization-apply")
                    .icon_start(icon(Icon::Globe2, IconSize::Md, Ds::get(cx)))
                    .text(copy.apply)
                    .when(busy || !changed, Button::disabled)
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.save(cx))),
            )
    }
}

impl Render for PersonalizationPage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = Ds::get(cx).lang();
        let copy = words(lang);
        let busy = self.busy(cx);
        let disabled = busy || self.personalization.is_none();
        let rows = self.migration_rows(copy, busy, cx);
        SettingsPage::new()
            .labels(SectionCtx::labels(cx))
            .footer(self.footer(copy, busy, cx))
            .section(self.profile_section(copy, disabled, cx))
            .section(self.response_style_section(copy, lang, disabled, cx))
            .section(self.learning_section(copy, lang, disabled, cx))
            .section(self.agent_import_section(copy, rows, cx))
    }
}
