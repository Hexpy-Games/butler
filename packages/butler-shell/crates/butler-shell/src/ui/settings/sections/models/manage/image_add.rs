//! `ImageModelAddPage.tsx`: the provider and its keyed hosted or custom image form.
mod form;

use std::rc::Rc;

use butler_ds::ui::blocks::settings_section::{SettingsPage, SettingsSection, SettingsSectionKind};
use butler_ds::ui::context::Ds;
use gpui::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, SharedString,
    Window, div,
};

use super::super::Navigate;
use super::copy::words;
use super::image_state::{CUSTOM_IMAGE, ImageModel, ImageSettingsState};
use crate::ui::settings::SectionCtx;
use crate::ui::settings::controls::{SettingsOption, SettingsSelect, provider_mark};
use form::ImageForm;

pub(crate) struct ImageAddPage {
    ctx: SectionCtx,
    navigate: Navigate,
    state: Entity<ImageSettingsState>,
    provider: String,
    form: Entity<ImageForm>,
}

impl ImageAddPage {
    pub(crate) fn new(ctx: SectionCtx, navigate: Navigate, cx: &mut Context<Self>) -> Self {
        let state = ImageSettingsState::shared(cx);
        cx.observe(&state, |_, _, cx| cx.notify()).detach();
        let provider = state
            .read(cx)
            .settings
            .as_ref()
            .and_then(|s| s.models.iter().find(|m| m.provider_id != CUSTOM_IMAGE))
            .map_or_else(|| CUSTOM_IMAGE.to_owned(), |m| m.provider_id.clone());
        let form = cx.new(|cx| ImageForm::new(ctx.clone(), navigate.clone(), provider.clone(), cx));
        Self {
            ctx,
            navigate,
            state,
            provider,
            form,
        }
    }

    /// The keyed `HostedImageModelForm` in `ImageModelAddPage.tsx`.
    fn change_provider(&mut self, provider: &str, cx: &mut Context<Self>) {
        if provider == self.provider {
            return;
        }
        provider.clone_into(&mut self.provider);
        self.form = cx.new(|cx| {
            ImageForm::new(
                self.ctx.clone(),
                self.navigate.clone(),
                self.provider.clone(),
                cx,
            )
        });
        cx.notify();
    }

    /// Provider options in model order (`ImageModelAddPage.tsx`).
    fn provider_section(&self, models: &[ImageModel], cx: &mut Context<Self>) -> SettingsSection {
        let copy = words(Ds::get(cx).lang());
        let mut options: Vec<SettingsOption> = Vec::new();
        for model in models.iter().filter(|m| m.provider_id != CUSTOM_IMAGE) {
            if options
                .iter()
                .any(|o| o.value.as_ref() == model.provider_id)
            {
                continue;
            }
            let provider = model.provider_id.clone();
            let mut option = SettingsOption::new(provider.clone(), model.provider_label.clone());
            option.icon = Some(Rc::new(move || provider_mark(&provider, None, true)));
            options.push(option);
        }
        options.push(SettingsOption::new(CUSTOM_IMAGE, copy.custom));
        SettingsSection::new(
            "image-model-provider",
            SettingsSectionKind::Form,
            copy.section_provider,
        )
        .child(
            crate::ui::widgets::anchor(div(), "image-model-add-provider-select").child(
                SettingsSelect::new("image-model-provider", copy.provider, self.provider.clone())
                    .options(options)
                    .on_change(cx.listener(|this, value: &SharedString, _, cx| {
                        this.change_provider(value, cx);
                    })),
            ),
        )
    }
}

impl Render for ImageAddPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let settings = self.state.read(cx).settings.clone();
        let models = settings.as_ref().map_or(&[][..], |s| s.models.as_slice());
        SettingsPage::new()
            .labels(SectionCtx::labels(cx))
            .section(self.provider_section(models, cx))
            .section(
                SettingsSection::new("image-model-add", SettingsSectionKind::Form, copy.model)
                    .child(self.form.clone()),
            )
    }
}
