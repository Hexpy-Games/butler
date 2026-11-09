//! The epic aside beside the board (`canon/CanonAside.tsx`, `EpicDetail.tsx`, `SpecTree.tsx`,
//! `useEpicInlineEdit.ts`, `useInlineExitGuard.ts`, `useCanonSelection.ts`). The detail itself is
//! [`EpicInspector`] (`EpicInspector.tsx`), which the session info also shows in compact form.
mod activity;
mod attach;
mod copy;
mod delete;
mod detail;
mod fields;
mod guard;
mod inspector;
mod proposals;
mod spec;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::conversation_shell::AsideLayout;
use butler_ds::ui::card::{Card, CardPadding};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Box as Pad, Cross, Justify, Space, Stack};
use butler_ds::ui::typo::Typo;
use gpui::{
    AnyElement, App, Context, Entity, InteractiveElement as _, IntoElement as _, SharedString,
    Window, div,
};
use gpui::{AppContext as _, ParentElement as _};

pub(crate) use inspector::EpicInspector;

use crate::ui::manage::{ManageCtx, View};
use crate::ui::widgets::anchor;
use copy::words;

/// `CanonAside`: one epic's detail.
pub(crate) struct CanonAside {
    ctx: ManageCtx,
    project: SharedString,
    inspector: Entity<EpicInspector>,
}

impl CanonAside {
    pub(crate) fn new(
        ctx: ManageCtx,
        project: SharedString,
        epic: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let inspector =
            cx.new(|cx| EpicInspector::new(ctx.clone(), project.clone(), epic, false, window, cx));
        Self {
            ctx,
            project,
            inspector,
        }
    }

    /// The aside in `layout` (docked beside the board, or floating).
    pub(crate) fn render_aside(
        &mut self,
        layout: AsideLayout,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let copy = words(Ds::get(cx).lang());
        let (ctx, project) = (self.ctx.clone(), self.project.clone());
        let close = IconButton::new("canon-aside-close", copy.close)
            .glyph(Icon::XIcon)
            .on_click(cx.listener(|this, _, _, cx| {
                select_epic(&this.ctx, this.project.clone(), None, cx);
            }));
        let content = Pad::new().padding(Space::Md).child(
            Stack::new()
                .gap(Space::Lg)
                .child(
                    Stack::row()
                        .gap(Space::Sm)
                        .cross(Cross::Center)
                        .justify(Justify::Between)
                        .child(Typo::panel_title(copy.epic))
                        .child(close),
                )
                .child(self.inspector.clone()),
        );
        // Escape dismisses the detail unless a field, menu or dialog took it first.
        let inspector = self.inspector.clone();
        let escape = move |event: &gpui::KeyDownEvent, _: &mut Window, cx: &mut App| {
            if event.keystroke.key == "escape" && !inspector.read(cx).dialog_open() {
                select_epic(&ctx, project.clone(), None, cx);
            }
        };
        let body: AnyElement = if layout == AsideLayout::Docked {
            Card::new("canon-aside-card")
                .padding(CardPadding::None)
                .child(content)
                .into_any_element()
        } else {
            content.into_any_element()
        };
        anchor(div().id("canon-aside"), "canon-aside")
            .on_key_down(escape)
            .child(body)
            .into_any_element()
    }
}

/// `useCanonSelection`: the epic the dashboard of `project` shows (its view's `epic`).
pub(crate) fn selected_epic(ctx: &ManageCtx, project: &str, cx: &App) -> Option<SharedString> {
    match ctx.view(cx) {
        View::ProjectDashboard {
            project: shown,
            epic,
        } if shown.as_ref() == project => epic,
        _ => None,
    }
}

/// Selects `epic` (`None` closes the aside) on the dashboard of `project`.
pub(crate) fn select_epic(
    ctx: &ManageCtx,
    project: SharedString,
    epic: Option<SharedString>,
    cx: &mut App,
) {
    ctx.set_view(View::ProjectDashboard { project, epic }, cx);
}
