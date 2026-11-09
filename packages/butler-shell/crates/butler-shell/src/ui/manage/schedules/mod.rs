//! 예약 작업 (`management/AutomationsView.tsx`): the list, or the detail of `ctx.view`.
#![allow(
    dead_code,
    reason = "seam: M2 calls AutomationRuns and hint_login; types are shared with M2"
)]
pub(crate) mod detail;
pub(crate) mod labels;
mod list;
mod runs;
pub(crate) mod types;

use std::rc::Rc;
use std::time::Duration;

use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::Error;
use gpui::{
    AnyElement, AnyView, App, AppContext as _, Context, Entity, IntoElement, ParentElement as _,
    Render, SharedString, Styled as _, Task, Window, div,
};

use super::{ManageCtx, View};
use crate::ui::source::fetch::{fetch_if, poll_every};
use detail::AutomationDetail;
use list::AutomationsList;
use types::{AutomationSummary, AutomationsPage};

pub(crate) use list::login::hint_login;
pub(crate) use runs::AutomationRuns;

/// `useAutomationsList`'s poll.
const POLL: Duration = Duration::from_secs(5);

/// `AutomationsView`
pub(crate) fn page(ctx: ManageCtx, _window: &mut Window, cx: &mut App) -> AnyView {
    cx.new(|cx| SchedulesPage::new(ctx, cx)).into()
}

struct SchedulesPage {
    ctx: ManageCtx,
    automations: Vec<AutomationSummary>,
    loaded: bool,
    failed: bool,
    detail: Option<(SharedString, Entity<AutomationDetail>)>,
    poll: Task<()>,
}

impl SchedulesPage {
    fn new(ctx: ManageCtx, cx: &mut Context<Self>) -> Self {
        cx.observe(&ctx.state, |_, _, cx| cx.notify()).detach();
        let mut page = Self {
            ctx,
            automations: Vec::new(),
            loaded: false,
            failed: false,
            detail: None,
            poll: Task::ready(()),
        };
        Self::load(cx);
        page.poll = poll_every(cx, POLL, |_, cx| Self::load(cx));
        page
    }

    /// `GET /automations`: the page redraws only when the list, or whether it loaded, changed. A
    /// failure toasts once until a read succeeds again (React's toast id `automation-load`).
    fn load(cx: &mut Context<Self>) {
        fetch_if(
            cx,
            |client| async move { client.list_automations(None).await },
            |page, result: Result<AutomationsPage, Error>, cx| match result {
                Ok(answer) => {
                    let changed =
                        !page.loaded || page.failed || page.automations != answer.automations;
                    let grew = answer.automations.len() != page.automations.len()
                        && !answer.automations.is_empty();
                    page.automations = answer.automations;
                    page.loaded = true;
                    page.failed = false;
                    if grew {
                        hint_login(cx);
                    }
                    changed
                }
                Err(_) => {
                    let changed = !page.loaded;
                    page.loaded = true;
                    if !page.failed {
                        let text = list::copy::words(Ds::get(cx).lang()).load_failed;
                        toast::show(cx, Toast::error(text));
                    }
                    page.failed = true;
                    changed
                }
            },
        );
    }

    /// The detail of `id`, rebuilt when the id changes.
    fn detail_for(
        &mut self,
        id: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        match &self.detail {
            Some((current, detail)) if *current == id => return detail.clone().into_any_element(),
            _ => {}
        }
        let back_ctx = self.ctx.clone();
        let on_back = Rc::new(move |_: &mut Window, cx: &mut App| {
            back_ctx.set_view(View::Automations, cx);
        });
        // `refresh`: reload the list, then the navigation.
        let page = cx.entity();
        let saved_ctx = self.ctx.clone();
        let on_saved = Rc::new(move |_: &mut Window, cx: &mut App| {
            page.update(cx, |_, cx| SchedulesPage::load(cx));
            saved_ctx.refresh_navigation(cx);
        });
        let ctx = self.ctx.clone();
        let entity =
            cx.new(|cx| AutomationDetail::new(ctx, id.clone(), on_back, on_saved, window, cx));
        self.detail = Some((id, entity.clone()));
        entity.into_any_element()
    }
}

impl Render for SchedulesPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let View::AutomationDetail(id) = self.ctx.view(cx) {
            return div().size_full().child(self.detail_for(id, window, cx));
        }
        self.detail = None;
        let ctx = self.ctx.clone();
        let on_select = Rc::new(move |id: SharedString, _: &mut Window, cx: &mut App| {
            ctx.set_view(View::AutomationDetail(id), cx);
        });
        let ctx = self.ctx.clone();
        let on_new = Rc::new(move |_: &mut Window, cx: &mut App| {
            ctx.set_view(View::AutomationDetail("new".into()), cx);
        });
        div().size_full().child(AutomationsList {
            automations: self.automations.clone(),
            loaded: self.loaded,
            on_select,
            on_new,
        })
    }
}
