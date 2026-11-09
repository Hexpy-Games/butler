//! A 예약 작업's detail (`management/AutomationDetail.tsx`, `AutomationForm.tsx`,
//! `stores/automationStore.ts`): the titlebar actions, the form, the browser switches and the
//! latest runs. The form is the page's own state; a save, run, pause or resume ends in
//! `on_saved`, and a delete in `on_saved` then `on_back`.
mod actions;
mod copy;
mod delete;
mod fields;
mod flow;
mod model;
mod timing;

use butler_ds::ui::blocks::management_page::ManagementPage;
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Columns, Grid, Space, Stack};
use gpui::{
    AnyWindowHandle, App, ClickEvent, Context, IntoElement, ParentElement as _, Render,
    SharedString, Styled as _, Window, div,
};

use self::copy::words;
use self::model::{Form, SaveError};
use crate::ui::composer::menus::ModelChoice;
use crate::ui::manage::schedules::types::AutomationRunSummary;
use crate::ui::manage::{Action, ManageCtx};
use crate::ui::widgets::anchor;

/// `AutomationDetail`: `automation_id` "new" creates.
#[expect(
    clippy::struct_excessive_bools,
    reason = "independent page states (new, vault, loaded, saving, confirming), not one mode"
)]
pub(crate) struct AutomationDetail {
    ctx: ManageCtx,
    automation_id: SharedString,
    is_new: bool,
    on_back: Action,
    on_saved: Action,
    window: AnyWindowHandle,
    form: Form,
    runs: Vec<AutomationRunSummary>,
    /// `runtimeModels(modelCatalog)`
    models: Vec<ModelChoice>,
    /// The settings' time zone, for a new calendar schedule (React: the browser's).
    timezone: String,
    /// `useVault().view?.available === false`
    vault_unavailable: bool,
    /// The form shows once the schedule (or the settings default for a new one) is read.
    ready: bool,
    saving: bool,
    error: Option<SaveError>,
    confirm_delete: bool,
}

impl AutomationDetail {
    pub(crate) fn new(
        ctx: ManageCtx,
        automation_id: SharedString,
        on_back: Action,
        on_saved: Action,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let is_new = automation_id.is_empty() || automation_id == "new";
        let general = words(Ds::get(cx).lang()).general_chat;
        let target = model::session_options(ctx.navigation(cx).as_deref(), general)
            .into_iter()
            .next()
            .map_or_else(|| "general".into(), |(id, _)| id);
        let mut detail = Self {
            ctx,
            automation_id,
            is_new,
            on_back,
            on_saved,
            window: window.window_handle(),
            form: Form::blank(target),
            runs: Vec::new(),
            models: Vec::new(),
            timezone: "UTC".to_owned(),
            vault_unavailable: false,
            ready: false,
            saving: false,
            error: None,
            confirm_delete: false,
        };
        Self::load_environment(cx);
        if !is_new {
            detail.load(cx);
        }
        detail
    }

    /// `withoutFieldError`
    fn clear_error(&mut self, field: model::Field) {
        self.error = model::without_field(self.error, field);
    }
}

/// A text control's handler: `apply` edits the page, which then redraws.
fn on_text(
    cx: &Context<AutomationDetail>,
    apply: impl Fn(&mut AutomationDetail, &str) + 'static,
) -> impl Fn(&str, &mut Window, &mut App) + 'static {
    let this = cx.entity().downgrade();
    move |text, _, cx| {
        let _ = this.update(cx, |this, cx| {
            apply(this, text);
            cx.notify();
        });
    }
}

/// A picking control's handler (a select, a switch, a time).
fn on_value<T: 'static>(
    cx: &Context<AutomationDetail>,
    apply: impl Fn(&mut AutomationDetail, T) + 'static,
) -> impl Fn(T, &mut Window, &mut App) + 'static {
    let this = cx.entity().downgrade();
    move |value, _, cx| {
        let _ = this.update(cx, |this, cx| {
            apply(this, value);
            cx.notify();
        });
    }
}

/// A button's handler; `apply` also gets the window and the page's context.
fn on_press(
    cx: &Context<AutomationDetail>,
    apply: impl Fn(&mut AutomationDetail, &mut Window, &mut Context<AutomationDetail>) + 'static,
) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
    let this = cx.entity().downgrade();
    move |_, window, cx| {
        let _ = this.update(cx, |this, cx| apply(this, window, cx));
    }
}

impl Render for AutomationDetail {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.ready {
            return anchor(div().size_full(), "automation-detail").into_any_element();
        }
        let words = words(Ds::get(cx).lang());
        let left = Stack::new()
            .gap(Space::Md)
            .child(self.title_field(words, cx))
            .child(self.prompt_field(words, cx));
        let right = Stack::new()
            .gap(Space::Xl)
            .child(self.details_section(words, window, cx))
            .child(self.browser_section(words, cx));
        let form = Grid::new("automation-form")
            .columns(Columns::fixed(2))
            .gap(Space::Xl)
            .child(left)
            .child(right);
        let page = ManagementPage::new("automation-detail-page")
            .child(self.actions(words, window, cx))
            .child(form);
        anchor(div().size_full(), "automation-detail")
            .child(page)
            .children(self.delete_dialog(words, window, cx))
            .into_any_element()
    }
}
