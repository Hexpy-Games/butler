//! Settings › Logs (`logs/LogsSettings.tsx`, developer mode): the log list, or one message's
//! trace (로그 › 메시지 추적) as a subpage. Leaving the section drops both, as React's
//! `leaveLogs` resets them.
mod list;
pub(crate) mod trace;

use std::rc::Rc;

use gpui::{
    AnyView, App, AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render,
    Window, div,
};

use self::list::{LogList, OpenTrace, ViewState};
use self::trace::{TracePage, TraceTarget, trace_title};
use crate::ui::settings::{Action, SectionCtx, Subpage};

/// `LogsSettings`
struct LogsPage {
    ctx: SectionCtx,
    /// The list; none while a trace shows. Its filter and live switch wait in `view`.
    list: Option<Entity<LogList>>,
    view: ViewState,
    trace: Option<Entity<TracePage>>,
}

impl LogsPage {
    fn new(ctx: SectionCtx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let view = ViewState::default();
        let mut page = Self {
            ctx,
            list: None,
            view,
            trace: None,
        };
        page.show_list(window, cx);
        page
    }

    fn show_list(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let weak = cx.weak_entity();
        let open: OpenTrace = Rc::new(move |target, window, cx| {
            let _ = weak.update(cx, |page, cx| page.open_trace(target, window, cx));
        });
        let (ctx, view) = (self.ctx.clone(), self.view.clone());
        self.list = Some(cx.new(|cx| LogList::new(ctx, open, view, window, cx)));
    }

    /// `openLogTrace`
    fn open_trace(&mut self, target: TraceTarget, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(list) = self.list.take() {
            self.view = list.read(cx).view_state();
        }
        let ctx = self.ctx.clone();
        self.trace = Some(cx.new(|cx| TracePage::new(ctx, target, window, cx)));
        let weak = cx.weak_entity();
        let on_logs: Action = Rc::new(move |window, cx| {
            let _ = weak.update(cx, |page, cx| page.close_trace(window, cx));
        });
        self.ctx.set_subpage(
            Some(Subpage {
                key: "logs/trace".into(),
                secondary: Rc::new(move |window, cx| trace_title(on_logs.clone(), window, cx)),
            }),
            cx,
        );
        cx.notify();
    }

    /// 로그: back to the list.
    fn close_trace(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.trace = None;
        self.ctx.set_subpage(None, cx);
        self.show_list(window, cx);
        cx.notify();
    }
}

impl Render for LogsPage {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .children(self.trace.clone())
            .children(self.list.clone())
    }
}

pub(crate) fn page(ctx: SectionCtx, window: &mut Window, cx: &mut App) -> AnyView {
    cx.new(|cx| LogsPage::new(ctx, window, cx)).into()
}
