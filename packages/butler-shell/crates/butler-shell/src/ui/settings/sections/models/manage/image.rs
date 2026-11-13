//! `ImageModelsSettings.tsx`: registered image models and the selected model's quality.
use std::rc::Rc;

use butler_ds::ui::blocks::settings_field::{ControlWidth, SettingsFieldGroup};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::toast::{Toast, ToastId};
use butler_shell_client::Error;
use gpui::{
    AnyElement, Context, Entity, IntoElement, ParentElement as _, Render, SharedString, Window,
};
use serde_json::{Value, json};

use super::super::{ModelRoute, Navigate};
use super::copy::words;
use super::image_state::{CUSTOM_IMAGE, ImageModel, ImageSettings, ImageSettingsState, Selection};
use super::notify;
use crate::ui::Icon;
use crate::ui::i18n::settings::words as frame_words;
use crate::ui::settings::SectionCtx;
use crate::ui::settings::controls::{SettingsOption, SettingsSelect, provider_mark};
use crate::ui::settings::state::fetch;

pub(crate) struct ImageModels {
    state: Entity<ImageSettingsState>,
    navigate: Navigate,
    busy: bool,
    toast: Option<ToastId>,
}

impl ImageModels {
    pub(crate) fn new(
        _: SectionCtx,
        navigate: Navigate,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let state = ImageSettingsState::shared(cx);
        state.update(cx, |_, cx| ImageSettingsState::refresh(cx));
        cx.observe(&state, |_, _, cx| cx.notify()).detach();
        Self {
            state,
            navigate,
            busy: false,
            toast: None,
        }
    }

    /// `save` in `ImageModelsSettings.tsx`.
    fn save(&mut self, selection: Option<Value>, cx: &mut Context<Self>) {
        self.busy = true;
        cx.notify();
        let body = selection.unwrap_or_else(|| json!({ "selected": null }));
        fetch(
            cx,
            move |client| async move { client.update_image_model_settings(&body).await },
            |this: &mut Self, result: Result<ImageSettings, Error>, cx| {
                this.busy = false;
                match result {
                    Ok(settings) => this.state.update(cx, |state, cx| state.set(settings, cx)),
                    Err(_) => {
                        let text = frame_words(Ds::get(cx).lang()).save_failed;
                        notify(&mut this.toast, Toast::error(text), cx);
                    }
                }
            },
        );
    }

    /// `choose` in `ImageModelsSettings.tsx`.
    fn choose(&mut self, model_ref: &str, cx: &mut Context<Self>) {
        if model_ref == "off" {
            self.save(None, cx);
            return;
        }
        let next = self
            .state
            .read(cx)
            .settings
            .as_ref()
            .and_then(|s| s.models.iter().find(|m| m.model_ref == model_ref))
            .map(|model| {
                json!({
                    "model_ref": model_ref,
                    "credential_id": model.credential_id,
                    "default_quality": model.default_quality,
                })
            });
        if let Some(next) = next {
            self.save(Some(next), cx);
        }
    }

    /// `ImageModelsSettings.tsx`: the root model select and management action.
    fn model_select(
        &self,
        settings: Option<&ImageSettings>,
        cx: &mut Context<Self>,
    ) -> SettingsSelect {
        let copy = words(Ds::get(cx).lang());
        let mut options = vec![SettingsOption::new("off", copy.image_off)];
        if let Some(settings) = settings {
            for model in settings
                .models
                .iter()
                .filter(|m| settings.registered.contains(&m.model_ref))
            {
                let provider = model.provider_id.clone();
                let mut option =
                    SettingsOption::new(model.model_ref.clone(), model.display_name.clone());
                option.group = Some(if provider == CUSTOM_IMAGE {
                    copy.custom.into()
                } else {
                    model.provider_label.clone().into()
                });
                option.icon = Some(Rc::new(move || provider_mark(&provider, None, false)));
                options.push(option);
            }
        }
        let navigate = self.navigate.clone();
        let manage = Button::new("settings-image-model-management-button")
            .variant(Variant::Outline)
            .size(Size::Lg)
            .icon_start(icon(Icon::Settings, IconSize::Md, Ds::get(cx)))
            .text(copy.manage_button)
            .on_click(move |_, window, cx| navigate(ModelRoute::ImageManagement, window, cx));
        let value = settings
            .and_then(|s| s.selected.as_ref())
            .map_or("off", |s| s.model_ref.as_str());
        SettingsSelect::new("image-model", copy.model, value.to_owned())
            .control_width(ControlWidth::Full)
            .action(manage)
            .options(options)
            .disabled(self.busy || settings.is_none())
            .on_change(cx.listener(|this, value: &SharedString, _, cx| this.choose(value, cx)))
    }

    /// `ImageModelsSettings.tsx`: quality keeps the selected credential.
    fn quality(
        &self,
        model: &ImageModel,
        selected: &Selection,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let copy = words(Ds::get(cx).lang());
        let options = model
            .qualities
            .iter()
            .map(|q| {
                let label = copy
                    .qualities
                    .iter()
                    .find(|(value, _)| *value == q)
                    .map_or_else(|| q.clone(), |(_, label)| (*label).to_owned());
                SettingsOption::new(q.clone(), label)
            })
            .collect();
        let (model_ref, credential_id) = (model.model_ref.clone(), selected.credential_id.clone());
        SettingsSelect::new(
            "image-quality",
            copy.default_quality,
            selected
                .default_quality
                .clone()
                .or_else(|| model.default_quality.clone())
                .unwrap_or_default(),
        )
        .options(options)
        .disabled(self.busy)
        .on_change(cx.listener(move |this, value: &SharedString, _, cx| {
            this.save(
                Some(
                    json!({"model_ref": model_ref, "credential_id": credential_id,
                    "default_quality": &**value}),
                ),
                cx,
            );
        }))
        .into_any_element()
    }
}

impl Render for ImageModels {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let settings = self.state.read(cx).settings.clone();
        let mut group = SettingsFieldGroup::new().child(self.model_select(settings.as_ref(), cx));
        if let Some(settings) = settings
            && let Some(selected) = &settings.selected
            && let Some(model) = settings
                .models
                .iter()
                .find(|m| m.model_ref == selected.model_ref)
            && !model.qualities.is_empty()
        {
            group = group.child(self.quality(model, selected, cx));
        }
        group
    }
}
