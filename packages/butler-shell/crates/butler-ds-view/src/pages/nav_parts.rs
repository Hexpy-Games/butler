//! The pieces the navigation showcases share (NavRow, NavSection, CollapsibleNavGroup,
//! OverflowActionMenu): the sidebar shell they sit in, a row menu, the dashboard and chevron
//! buttons of a project row, and a boolean held in the page's state.
use butler_ds::tokens::Length;
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::nav_row::NavRowSwap;
use butler_ds::ui::blocks::overflow_action_menu::{OverflowActionMenu, OverflowItem};
use butler_ds::ui::blocks::sidebar_shell::SidebarShell;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::unread_dot::UnreadDot;
use gpui::{
    AnyElement, App, ClickEvent, ElementId, IntoElement, ParentElement as _, RenderOnce,
    SharedString, Styled as _, Window, div,
};

/// The app's SidebarShell with `scrollFade={false}`: it sizes row actions and the active fill.
pub(super) fn sidebar(id: &'static str, rows: impl IntoIterator<Item = AnyElement>) -> AnyElement {
    let mut shell = SidebarShell::new(id).scroll_fade(false);
    for row in rows {
        shell = shell.child(row);
    }
    shell.into_any_element()
}

/// A boolean held in the page's state, as the React stories' `useState`.
pub(super) fn flag(
    id: impl Into<ElementId>,
    initial: bool,
    window: &mut Window,
    cx: &mut App,
) -> (
    bool,
    impl Fn(&ClickEvent, &mut Window, &mut App) + Clone + 'static,
) {
    let state = window.use_keyed_state(id, cx, move |_, _| initial);
    let on = *state.read(cx);
    (on, move |_: &ClickEvent, _: &mut Window, cx: &mut App| {
        state.update(cx, |on, cx| {
            *on = !*on;
            cx.notify();
        });
    })
}

/// `rowMenu`: the rest content (the unread dot at rest) gives way to the row menu on hover,
/// focus or while open.
pub(super) fn row_menu(
    id: impl Into<SharedString>,
    rest: Option<AnyElement>,
    open: bool,
    (menu, rename, archive, unread): (&'static str, &'static str, &'static str, &'static str),
) -> AnyElement {
    let id: SharedString = id.into();
    let rest = rest.unwrap_or_else(|| {
        UnreadDot::new((ElementId::from(id.clone()), "unread"), unread)
            .present(false)
            .into_any_element()
    });
    let menu = OverflowActionMenu::new(id.clone(), menu)
        .item(OverflowItem::new(rename).icon(Icon::PencilLine))
        .item(OverflowItem::new(archive).icon(Icon::Archive));
    NavRowSwap::new((ElementId::from(id), "swap"), menu)
        .rest(rest)
        .open(open)
        .into_any_element()
}

/// An icon button of a row's actions at the enclosing scope's size.
pub(super) fn action_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    glyph: Icon,
) -> IconButton {
    IconButton::new(id, label).glyph(glyph)
}

/// `ButtonContainer size="icon-sm"`: a row of icon buttons; inside a sidebar they sit
/// `--space-xs / 2` apart (SidebarShell.module.css:42).
#[derive(IntoElement)]
pub(super) struct Cluster(Vec<AnyElement>);

pub(super) fn icon_cluster(buttons: impl IntoIterator<Item = AnyElement>) -> Cluster {
    Cluster(buttons.into_iter().collect())
}

impl RenderOnce for Cluster {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let gap = if butler_ds::ui::blocks::scope::in_density(cx) {
            ds.len(Length::SpaceXs) / 2.
        } else {
            ds.len(Length::SpaceSm)
        };
        div().flex().items_center().gap(gap).children(self.0)
    }
}
