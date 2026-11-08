//! Settings: Updates (`UpdatesSettings.tsx`, `UpdatePreviewSwitch.tsx`, `useUpdateActions.ts`).
//!
//! The page reads `/updates` on open and after its own actions (live progress events are not
//! ported). The App's restart coordinator (Electron `useAppUpdateState`) is
//! `lifecycle::app_update`; a staged App package goes to it after Apply.
mod copy;
mod model;
mod row;

use std::rc::Rc;

use butler_ds::ui::blocks::settings_section::{
    SettingsPage, SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::toast::{self, Toast, ToastId};
use butler_shell_client::Error;
use gpui::{
    AnyView, App, AppContext as _, ClickEvent, Context, Entity, IntoElement, ParentElement as _,
    Render, Subscription, Window,
};
use serde::Deserialize;
use serde_json::json;

use self::copy::words;
use self::model::{APP, Cancelled, ComponentView, Progress, Status};
use self::row::Row;
use crate::lifecycle::app_update::{self, AppUpdateStatus};
use crate::ui::Icon;
use crate::ui::settings::controls::SettingsSwitch;
use crate::ui::settings::state::fetch;
use crate::ui::settings::{Save, SectionCtx, SettingsState};

pub(crate) fn page(ctx: SectionCtx, _: &mut Window, cx: &mut App) -> AnyView {
    cx.new(|cx| UpdatesPage::new(ctx, cx)).into()
}

/// The settings field the channel switch reads.
#[derive(Deserialize)]
struct Channel {
    #[serde(default)]
    update_previews: bool,
}

struct UpdatesPage {
    ctx: SectionCtx,
    /// The components of the last status read.
    view: Option<Vec<ComponentView>>,
    loading: bool,
    load_failed: bool,
    /// The newest progress snapshot (`useUpdateProgressStore`).
    progress: Option<Progress>,
    /// Whether the last status had an unchecked component.
    unchecked: bool,
    /// The preview setting being saved (`UpdatePreviewSwitch` `saving`).
    preview: Option<bool>,
    toast: Option<ToastId>,
    _settings: Subscription,
}

impl UpdatesPage {
    fn new(ctx: SectionCtx, cx: &mut Context<Self>) -> Self {
        let settings = cx.observe(&ctx.state, |this, state, cx| {
            this.settings_changed(&state, cx);
        });
        let update = app_update::entity(cx);
        cx.observe(&update, |_, _, cx| cx.notify()).detach();
        let mut page = Self {
            ctx,
            view: None,
            loading: false,
            load_failed: false,
            progress: None,
            unchecked: false,
            preview: None,
            toast: None,
            _settings: settings,
        };
        page.load(cx);
        page
    }

    /// `change` of `UpdatePreviewSwitch`: once the save has landed, the check runs.
    fn settings_changed(&mut self, state: &Entity<SettingsState>, cx: &mut Context<Self>) {
        if let Some(enabled) = self.preview
            && !state.read(cx).saving()
        {
            self.preview = None;
            let saved = state.read(cx).slice::<Channel>().map(|c| c.update_previews);
            if saved == Some(enabled) {
                self.check(false, cx);
            }
        }
        cx.notify();
    }

    fn set_preview(&mut self, enabled: bool, cx: &mut Context<Self>) {
        self.preview = Some(enabled);
        self.ctx.save(
            json!({ "update_previews": enabled }),
            Save {
                optimistic: false,
                silent: true,
            },
            cx,
        );
        cx.notify();
    }

    fn notify(&mut self, toast: Toast, cx: &mut Context<Self>) {
        let toast = match self.toast {
            Some(id) => toast.id(id),
            None => toast,
        };
        self.toast = Some(toast::show(cx, toast));
    }

    /// `useUpdateProgressStore.receive`: an older revision is ignored; a stage that turns
    /// `completed` reloads the status.
    fn receive(&mut self, progress: Option<Progress>, cx: &mut Context<Self>) {
        let Some(next) = progress else { return };
        let last = self.progress.as_ref();
        if last.is_some_and(|last| last.revision > next.revision) {
            return;
        }
        let completed =
            next.stage == "completed" && last.map(|p| p.stage.as_str()) != Some("completed");
        self.progress = Some(next);
        if completed {
            self.load(cx);
        }
    }

    fn receive_status(&mut self, status: Status, cx: &mut Context<Self>) {
        self.receive(status.progress, cx);
        self.set_view(status.components, cx);
    }

    /// `setView`: a status that was never checked fills in by itself once the check runs.
    fn set_view(&mut self, components: Vec<ComponentView>, cx: &mut Context<Self>) {
        let unchecked = components
            .iter()
            .any(|c| c.check_state.as_deref() == Some("unchecked"));
        self.view = Some(components);
        let check = unchecked && !self.unchecked;
        self.unchecked = unchecked;
        if check {
            self.check(true, cx);
        }
    }

    /// `load`: GET /updates
    fn load(&mut self, cx: &mut Context<Self>) {
        self.loading = true;
        self.load_failed = false;
        fetch(
            cx,
            |client| async move { client.get_updates().await },
            |this: &mut Self, result: Result<Status, Error>, cx| {
                this.loading = false;
                match result {
                    Ok(status) => this.receive_status(status, cx),
                    Err(_) => this.load_failed = true,
                }
            },
        );
    }

    /// `check`: POST /updates/check; a silent check reports no failure.
    fn check(&mut self, silent: bool, cx: &mut Context<Self>) {
        self.loading = true;
        fetch(
            cx,
            |client| async move { client.check_updates(&json!({ "component": APP })).await },
            move |this: &mut Self, result: Result<Status, Error>, cx| {
                this.loading = false;
                match result {
                    Ok(status) => this.receive_status(status, cx),
                    Err(_) if !silent => {
                        let copy = words(Ds::get(cx).lang());
                        this.notify(Toast::error(copy.check_failed), cx);
                    }
                    Err(_) => {}
                }
            },
        );
    }

    /// `apply`: POST /updates/apply. The answer replaces the component's status.
    fn apply(component: String, cx: &mut Context<Self>) {
        fetch(
            cx,
            move |client| async move {
                client
                    .apply_update(&json!({ "component": component }))
                    .await
            },
            |this: &mut Self, result: Result<ComponentView, Error>, cx| match result {
                Ok(applied) => {
                    Self::open_staged(&applied, cx);
                    let mut components = this
                        .view
                        .clone()
                        .unwrap_or_else(|| vec![ComponentView::empty(APP)]);
                    for component in &mut components {
                        if component.component == applied.component {
                            *component = applied.clone();
                        }
                    }
                    this.set_view(components, cx);
                }
                Err(_) => Self::apply_failed(cx),
            },
        );
    }

    /// `butler:open-update-artifact`: an App package that is staged is handed to the installer
    /// (`applyUpdate` of the preload). A refusal reads like a failed apply.
    fn open_staged(applied: &ComponentView, cx: &mut Context<Self>) {
        let path = applied.artifact_path.as_deref().unwrap_or("").trim();
        let staged = applied.stage_status.as_deref() == Some("staged");
        if applied.component != APP || !staged || path.is_empty() {
            return;
        }
        let opened = app_update::open_staged(&json!({ "artifact_path": path }), cx);
        cx.spawn(async move |this, cx| {
            if opened.await.is_err() {
                let _ = this.update(cx, |_, cx| Self::apply_failed(cx));
            }
        })
        .detach();
    }

    /// The failed or cancelled snapshot owns the feedback; without one, a generic error.
    fn apply_failed(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.get_updates().await },
            |this: &mut Self, result: Result<Status, Error>, cx| {
                if let Ok(status) = result {
                    let failed = status
                        .progress
                        .as_ref()
                        .is_some_and(|p| p.stage == "failed");
                    this.receive_status(status, cx);
                    if failed {
                        return;
                    }
                }
                let copy = words(Ds::get(cx).lang());
                this.notify(Toast::error(copy.error_generic), cx);
            },
        );
    }

    /// The download's Cancel: POST /updates/cancel
    fn cancel(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.cancel_update().await },
            |this: &mut Self, result: Result<Cancelled, Error>, cx| {
                let copy = words(Ds::get(cx).lang());
                match result {
                    Ok(done) => {
                        if done.cancelled {
                            this.notify(Toast::message(copy.cancelled), cx);
                        }
                        this.load(cx);
                    }
                    Err(_) => this.notify(Toast::error(copy.apply_failed), cx),
                }
            },
        );
    }
}

impl UpdatesPage {
    /// `UpdatePreviewSwitch`
    fn channel_section(
        &self,
        copy: &'static copy::Words,
        busy: bool,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let page = cx.entity().downgrade();
        let checked = self
            .ctx
            .state
            .read(cx)
            .slice::<Channel>()
            .is_some_and(|c| c.update_previews);
        SettingsSection::new("update-channel", SettingsSectionKind::Form, copy.channel)
            .holds_fields()
            .child(
                SettingsSwitch::new("update-previews", copy.receive_previews)
                    .description(copy.receive_previews_description)
                    .checked(checked)
                    .disabled(busy || self.preview.is_some())
                    .on_change(move |enabled, _, cx| {
                        let _ = page.update(cx, |this, cx| this.set_preview(enabled, cx));
                    }),
            )
    }
}

impl Render for UpdatesPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let restart = app_update::status(cx);
        let restart_running = matches!(
            restart,
            AppUpdateStatus::Preparing
                | AppUpdateStatus::Restarting
                | AppUpdateStatus::ChoiceRequired(_)
        );
        let applying = self
            .progress
            .as_ref()
            .filter(|progress| progress.is_running())
            .map(|progress| progress.component.as_str())
            .or(restart_running.then_some(APP));
        let busy = self.loading || applying.is_some();

        let channel = self.channel_section(copy, busy, cx);

        let state = match (&self.view, self.load_failed) {
            (Some(_), _) => SettingsSectionState::Ready,
            (None, true) => SettingsSectionState::Error,
            (None, false) => SettingsSectionState::Loading,
        };
        let mut check = Button::new("update-check")
            .size(Size::Sm)
            .variant(Variant::Outline)
            .icon_start(icon(Icon::RefreshCcw, IconSize::Md, Ds::get(cx)))
            .text(if self.loading {
                copy.checking
            } else {
                copy.check
            })
            .on_click(cx.listener(|this, _, _, cx| this.check(false, cx)));
        if busy {
            check = check.disabled();
        }
        let mut versions =
            SettingsSection::new("updates", SettingsSectionKind::List, copy.versions)
                .state(state)
                .error_message(copy.load_failed)
                .on_retry(cx.listener(|this, _, _, cx| this.load(cx)))
                .actions(check);
        let empty = ComponentView::empty(APP);
        let status = self
            .view
            .as_ref()
            .and_then(|view| view.iter().find(|c| c.component == APP))
            .unwrap_or(&empty);
        let progress = self
            .progress
            .as_ref()
            .filter(|p| p.component == status.component);
        let component = status.component.clone();
        let apply = cx.listener(move |_, _: &ClickEvent, _, cx| Self::apply(component.clone(), cx));
        let cancel = cx.listener(|_, _: &ClickEvent, _, cx| Self::cancel(cx));
        versions = versions.child(
            Row {
                status,
                applying,
                progress,
                restart: &restart,
                copy,
                on_apply: Rc::new(apply),
                on_cancel: Rc::new(cancel),
            }
            .render(cx),
        );

        SettingsPage::new()
            .labels(SectionCtx::labels(cx))
            .section(channel)
            .section(versions)
    }
}
