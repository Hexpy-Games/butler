//! The Models page itself (`ModelsRootPage` in `ModelsSettings.tsx`). The main model and backup
//! models are always visible; worker profiles sit under an Advanced disclosure.
mod backup;
mod butler;
pub(crate) mod copy;
pub(crate) mod data;

use butler_ds::ui::blocks::disclosure_row::DisclosureRow;
use butler_ds::ui::blocks::settings_section::{SettingsPage, SettingsSection, SettingsSectionKind};
use butler_ds::ui::toast::ToastId;
use gpui::{AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, Window};

use super::Navigate;
use super::manage::ImageModels;
use super::workers::WorkerProfiles;
use crate::ui::settings::SectionCtx;

pub(super) struct RootPage {
    ctx: SectionCtx,
    navigate: Navigate,
    /// The body of the `image-models` section.
    image: Entity<ImageModels>,
    workers: Entity<WorkerProfiles>,
    /// `advancedOpen`
    advanced_open: bool,
    backup: backup::Ui,
    /// The `settings-context-limit` toast.
    clamp_toast: Option<ToastId>,
    /// The `settings-local-reasoning-budget` toast.
    budget_toast: Option<ToastId>,
}

impl RootPage {
    pub(super) fn new(
        ctx: SectionCtx,
        navigate: Navigate,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(&ctx.state, |_, _, cx| cx.notify()).detach();
        let image = cx.new(|cx| ImageModels::new(ctx.clone(), window, cx));
        let workers = cx.new(|cx| WorkerProfiles::new(ctx.clone(), cx));
        cx.observe(&workers, |_, _, cx| cx.notify()).detach();
        Self {
            ctx,
            navigate,
            image,
            workers,
            advanced_open: false,
            backup: backup::Ui::default(),
            clamp_toast: None,
            budget_toast: None,
        }
    }
}

impl Render for RootPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let words = copy::get(cx);
        let advanced = SettingsSection::new(
            "advanced-models",
            SettingsSectionKind::Form,
            words.advanced_title,
        )
        .child(
            DisclosureRow::new("settings-models-advanced", words.advanced_contents)
                .reveals()
                .open(self.advanced_open)
                .on_toggle(cx.listener(|this, _, _, cx| {
                    this.advanced_open = !this.advanced_open;
                    cx.notify();
                })),
        );
        let mut page = SettingsPage::new()
            .labels(SectionCtx::labels(cx))
            .section(self.butler_section(cx))
            .section(self.backup_section(window, cx))
            .section(
                SettingsSection::new(
                    "image-models",
                    SettingsSectionKind::Form,
                    words.image_models_section,
                )
                .child(self.image.clone()),
            )
            .section(advanced);
        if self.advanced_open {
            let workers = self
                .workers
                .update(cx, super::workers::WorkerProfiles::section);
            page = page.section(workers);
        }
        page
    }
}
