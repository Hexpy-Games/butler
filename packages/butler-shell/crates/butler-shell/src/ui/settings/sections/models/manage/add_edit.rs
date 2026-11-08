//! `ModelAddEditPage.tsx`: add a model (choose the provider) or edit a registered one; a hosted
//! provider shows the hosted form, the custom one shows the local model settings.
use std::rc::Rc;

use butler_ds::ui::blocks::settings_section::{SettingsPage, SettingsSection, SettingsSectionKind};
use butler_ds::ui::context::Ds;
use gpui::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, SharedString, Window,
};

use super::super::local::LocalModelSettings;
use super::super::{ModelRoute, Navigate};
use super::catalog::{Catalog, CatalogModel, LOCAL_PROVIDER_ID};
use super::copy::words;
use super::hosted::{HostedForm, Saved};
use crate::ui::settings::SectionCtx;
use crate::ui::settings::controls::{SettingsOption, SettingsSelect, provider_mark};

/// `ModelAddEditPage`: add (`model_ref` none) or edit one model.
pub(crate) struct AddEditPage {
    ctx: SectionCtx,
    /// The model being edited, none when adding.
    model_ref: Option<SharedString>,
    navigate: Navigate,
    /// `providerId` as the owner chose it; the page shows the first provider when it is gone.
    chosen: Option<SharedString>,
    hosted: Entity<HostedForm>,
    /// Present while the custom provider is chosen.
    local: Option<Entity<LocalModelSettings>>,
}

impl AddEditPage {
    pub(crate) fn new(
        ctx: SectionCtx,
        model_ref: Option<SharedString>,
        navigate: Navigate,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let hosted = cx.new(|cx| HostedForm::new(ctx.clone(), model_ref.clone(), cx));
        cx.observe(&hosted, |_, _, cx| cx.notify()).detach();
        cx.observe(&ctx.state, |_, _, cx| cx.notify()).detach();
        // `back()` after a registration.
        cx.subscribe_in(&hosted, window, |this, _, _: &Saved, window, cx| {
            (this.navigate)(ModelRoute::Management, window, cx);
        })
        .detach();
        Self {
            ctx,
            model_ref,
            navigate,
            chosen: None,
            hosted,
            local: None,
        }
    }

    /// The provider shown: the edited model's, else the owner's choice while it is offered,
    /// else the first hosted provider, else custom.
    fn provider(&self, catalog: &Catalog, editing: Option<&CatalogModel>) -> SharedString {
        if let Some(model) = editing {
            return model.provider_id.clone().into();
        }
        let mut hosted = catalog.hosted_providers();
        if let Some(chosen) = &self.chosen
            && (&**chosen == LOCAL_PROVIDER_ID
                || hosted.any(|provider| provider.provider_id == **chosen))
        {
            return chosen.clone();
        }
        catalog
            .hosted_providers()
            .next()
            .map_or(LOCAL_PROVIDER_ID, |provider| provider.provider_id.as_str())
            .to_owned()
            .into()
    }

    /// The `model-provider` section: hosted providers, then custom.
    fn provider_section(
        catalog: &Catalog,
        provider: &SharedString,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let copy = words(Ds::get(cx).lang());
        let mut options: Vec<SettingsOption> = catalog
            .hosted_providers()
            .map(|p| {
                let id = p.provider_id.clone();
                let mut option = SettingsOption::new(id.clone(), p.provider_label.clone());
                option.icon = Some(Rc::new(move || provider_mark(&id, None, true)));
                option
            })
            .collect();
        let mut custom = SettingsOption::new(LOCAL_PROVIDER_ID, copy.local);
        custom.icon = Some(Rc::new(|| provider_mark(LOCAL_PROVIDER_ID, None, false)));
        options.push(custom);
        let select = SettingsSelect::new("model-provider", copy.provider, provider.clone())
            .options(options)
            .on_change(cx.listener(|this, value: &SharedString, _, cx| {
                this.chosen = Some(value.clone());
                cx.notify();
            }));
        SettingsSection::new(
            "model-provider",
            SettingsSectionKind::Form,
            copy.section_provider,
        )
        .child(select)
    }

    /// The local model settings, made when the custom provider is first shown.
    fn local_page(
        &mut self,
        editing: Option<&CatalogModel>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<LocalModelSettings> {
        if let Some(local) = &self.local {
            return local.clone();
        }
        let initial = editing
            .filter(|model| model.provider_id == LOCAL_PROVIDER_ID)
            .map(|model| model.model_ref.clone().into());
        let navigate = self.navigate.clone();
        let on_back: crate::ui::settings::Action =
            Rc::new(move |window, app| navigate(ModelRoute::Management, window, app));
        let ctx = self.ctx.clone();
        let local = cx.new(|cx| LocalModelSettings::new(ctx, initial, on_back, window, cx));
        cx.observe(&local, |_, _, cx| cx.notify()).detach();
        self.local = Some(local.clone());
        local
    }
}

impl Render for AddEditPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut page = SettingsPage::new().labels(SectionCtx::labels(cx));
        let hosted = self.hosted.clone();
        let catalog = Catalog::read(self.ctx.state.read(cx));
        let Some(catalog) = catalog else {
            return page.section(hosted.update(cx, |form, cx| form.section("", None, cx)));
        };
        let editing = self.model_ref.as_ref().and_then(|r| {
            catalog
                .registered_models
                .iter()
                .find(|m| m.model_ref == **r)
        });
        let provider = self.provider(&catalog, editing);
        if self.model_ref.is_none() {
            page = page.section(Self::provider_section(&catalog, &provider, cx));
        }
        if *provider == *LOCAL_PROVIDER_ID {
            let local = self.local_page(editing, window, cx);
            let sections = local.update(cx, |local, cx| local.sections(window, cx));
            return sections.into_iter().fold(
                page,
                butler_ds::ui::blocks::settings_section::SettingsPage::section,
            );
        }
        self.local = None;
        page.section(hosted.update(cx, |form, cx| form.section(&provider, Some(&catalog), cx)))
    }
}
