//! DS SettingsShell (SettingsShell.tsx / SettingsShell.module.css): the settings screen layout. A
//! navigation master, a detail header and a scrolling detail pane; one pane at a time on compact
//! widths. The detail content is wrapped in a settings page provider (see [`page`]). Changing the
//! page re-enters the header and content from the direction of travel; changing the compact
//! pane slides the new one in.
mod page;

use gpui::{
    AnyElement, App, Div, ElementId, InteractiveElement as _, IntoElement, ParentElement as _,
    Pixels, RenderOnce, SharedString, Styled as _, Window, WindowControlArea, div, px,
};

pub use page::{SettingsPageCopy, repeats_settings_copy, settings_page, settings_page_provider};

use super::message_row::enter;
use super::scope::{self, Spec};
use crate::tokens::{Color, Duration as DsDuration, Easing, Length};
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::scroll::ScrollArea;
use crate::ui::strut;

/// The widest compact window (`@media (width <= 760px)`).
const COMPACT_MAX: f32 = 760.; // DS: SettingsShell.module.css:113
/// The detail content's room under the last section.
const CONTENT_BOTTOM: f32 = 60.; // DS: SettingsShell.module.css:98
/// The detail pane's padding: top, inline (`padding: 28px 32px 0`).
const DETAIL_TOP: f32 = 28.; // DS: SettingsShell.module.css:50
const DETAIL_INLINE: f32 = 32.; // DS: SettingsShell.module.css:50
/// The active detail pane's top padding past the title row.
const DETAIL_ACTIVE_TOP: f32 = 18.; // DS: SettingsShell.module.css:59
/// The sidebar's share of the surface fill (`color-mix(var(--surface) 84%, transparent)`).
const SIDEBAR_FILL: f32 = 0.84; // DS: SettingsShell.module.css:35

/// Which pane a compact window shows (`compactPane`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CompactPane {
    #[default]
    Master,
    Detail,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Direction {
    #[default]
    None,
    Forward,
    Backward,
}

/// The page the shell last showed, for the direction of the next change.
struct PageMotion {
    key: Option<SharedString>,
    order: Option<i32>,
    direction: Direction,
    epoch: u64,
}

#[derive(IntoElement)]
pub struct SettingsShell {
    id: ElementId,
    sidebar: Option<AnyElement>,
    detail_header: Option<AnyElement>,
    detail: Option<AnyElement>,
    active: bool,
    compact_pane: CompactPane,
    detail_navigation: Option<AnyElement>,
    page_title: Option<SharedString>,
    page_description: Option<SharedString>,
    page_key: Option<SharedString>,
    page_order: Option<i32>,
}

impl SettingsShell {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            sidebar: None,
            detail_header: None,
            detail: None,
            active: false,
            compact_pane: CompactPane::Master,
            detail_navigation: None,
            page_title: None,
            page_description: None,
            page_key: None,
            page_order: None,
        }
    }

    pub fn sidebar(mut self, sidebar: impl IntoElement) -> Self {
        self.sidebar = Some(sidebar.into_any_element());
        self
    }

    pub fn detail_header(mut self, header: impl IntoElement) -> Self {
        self.detail_header = Some(header.into_any_element());
        self
    }

    pub fn detail(mut self, detail: impl IntoElement) -> Self {
        self.detail = Some(detail.into_any_element());
        self
    }

    /// The screen fills the window: it clears the title row and holds the drag lane.
    pub fn active(mut self) -> Self {
        self.active = true;
        self
    }

    pub fn compact_pane(mut self, pane: CompactPane) -> Self {
        self.compact_pane = pane;
        self
    }

    /// The back button a compact detail header leads with.
    pub fn detail_navigation(mut self, navigation: impl IntoElement) -> Self {
        self.detail_navigation = Some(navigation.into_any_element());
        self
    }

    /// The title the detail header shows; sections never repeat it.
    pub fn page_title(mut self, title: impl Into<SharedString>) -> Self {
        self.page_title = Some(title.into());
        self
    }

    /// The description the detail header shows; section descriptions never repeat it.
    pub fn page_description(mut self, description: impl Into<SharedString>) -> Self {
        self.page_description = Some(description.into());
        self
    }

    /// Changes when the page changes; the header and content re-enter with the page transition.
    pub fn page_key(mut self, key: impl Into<SharedString>) -> Self {
        self.page_key = Some(key.into());
        self
    }

    /// The page's position in the navigation: a larger order enters from below, a smaller from
    /// above.
    pub fn page_order(mut self, order: i32) -> Self {
        self.page_order = Some(order);
        self
    }
}

/// The direction of the latest page change; the first page does not animate. Returns it with the
/// change count, which keys the transition's clock.
fn page_direction(shell: &SettingsShell, window: &mut Window, cx: &mut App) -> (Direction, u64) {
    let (key, order) = (shell.page_key.clone(), shell.page_order);
    let state = window.use_keyed_state((shell.id.clone(), "page"), cx, |_, _| PageMotion {
        key: key.clone(),
        order,
        direction: Direction::None,
        epoch: 0,
    });
    state.update(cx, |page, _| {
        if page.key != key {
            page.direction = match (page.order, order) {
                (Some(from), Some(to)) if to > from => Direction::Forward,
                (Some(from), Some(to)) if to < from => Direction::Backward,
                _ => Direction::None,
            };
            (page.key, page.order, page.epoch) = (key, order, page.epoch + 1);
        }
        (page.direction, page.epoch)
    })
}

/// `el` entering with the page transition: it fades in and rises (or drops) by the distance.
fn page_moved(el: Div, enter: Option<(f32, f32)>) -> Div {
    match enter {
        Some((progress, dy)) => el
            .relative()
            .opacity(progress)
            .top(px(dy * (1. - progress))),
        None => el,
    }
}

/// `el` sliding in from `from` px to the side as a compact pane changes.
fn pane_moved(el: Div, progress: f32, from: f32) -> Div {
    el.relative()
        .opacity(progress)
        .left(px(from * (1. - progress)))
}

struct Look {
    compact: bool,
    cards: bool,
}

impl SettingsShell {
    fn sidebar_pane(&mut self, look: &Look, ds: &Ds) -> Div {
        let pad = |active: bool| -> Pixels {
            match (look.compact, active) {
                (true, _) => ds.len(Length::TitlebarSafeAreaTop),
                (false, true) => ds.len(Length::TitlebarHeight) + ds.len(Length::Space2),
                (false, false) => ds.len(Length::Space5),
            }
        };
        let inline = if look.compact {
            ds.len(Length::AdaptivePageGutter)
        } else {
            ds.len(Length::Space3)
        };
        let bottom = if look.compact {
            ds.len(Length::Space2xl)
        } else {
            ds.len(Length::Space5)
        };
        let pane = div()
            .flex()
            .flex_col()
            .min_h_0()
            .overflow_hidden()
            .pt(pad(self.active))
            .pb(bottom)
            .px(inline)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_auto()
                    .min_h_0()
                    .children(self.sidebar.take()),
            );
        if look.compact {
            return pane.flex_auto().w_full();
        }
        let (width, min) = if self.active {
            (274., 236.)
        } else {
            (236., 220.)
        }; // DS: SettingsShell.module.css:1
        let pane = pane.w(px(width)).min_w(px(min)).flex_none();
        if look.cards {
            pane
        } else {
            pane.border_r(ds.len(Length::BorderHairline))
                .border_color(ds.color(Color::Line))
                .bg(convert::with_alpha(ds.color(Color::Surface), SIDEBAR_FILL))
        }
    }

    /// The detail header: a compact window leads it with the navigation slot.
    fn header(&mut self, look: &Look, ds: &Ds, enter: Option<(f32, f32)>) -> Option<AnyElement> {
        let header = self.detail_header.take()?;
        let mut row = div()
            .flex()
            .w_full()
            .max_w(ds.len(Length::PageMaxWidthReading))
            .flex_none()
            .gap(ds.len(Length::SpaceSm));
        if look.compact
            && let Some(navigation) = self.detail_navigation.take()
        {
            row = row.child(
                div()
                    .flex()
                    .flex_none()
                    .w(ds.len(Length::ControlHitTarget))
                    .child(navigation),
            );
        }
        Some(
            page_moved(row.child(div().flex_auto().min_w_0().child(header)), enter)
                .into_any_element(),
        )
    }

    fn content(&mut self, look: &Look, ds: &Ds, id: &ElementId, enter: Option<(f32, f32)>) -> Div {
        let copy = SettingsPageCopy {
            title: self.page_title.take(),
            description: self.page_description.take(),
        };
        let detail = settings_page_provider(
            copy,
            self.detail
                .take()
                .unwrap_or_else(|| div().into_any_element()),
        );
        let bottom = if look.compact {
            px(CONTENT_BOTTOM).max(ds.len(Length::Space2xl))
        } else {
            px(CONTENT_BOTTOM)
        };
        let column = div()
            .flex()
            .flex_col()
            .w_full()
            .max_w(ds.len(Length::PageMaxWidthReading))
            .gap(ds.len(Length::SettingsSectionGap))
            .pb(bottom)
            .child(detail);
        let scroll = ScrollArea::new((id.clone(), "scroll"))
            .fill()
            .child(page_moved(column, enter));
        div().flex().flex_col().flex_auto().min_h_0().child(scroll)
    }

    fn detail_pane(
        &mut self,
        look: &Look,
        ds: &Ds,
        enter: Option<(f32, f32)>,
        id: &ElementId,
    ) -> Div {
        let pane = div()
            .flex()
            .flex_col()
            .flex_auto()
            .min_w_0()
            .min_h_0()
            .overflow_hidden()
            .relative();
        let header = self.header(look, ds, enter);
        let content = self.content(look, ds, id, enter);
        let pane = if look.compact {
            let top = ds.len(Length::TitlebarSafeAreaTop);
            let inline = ds.len(Length::AdaptivePageGutter);
            pane.gap(ds.len(Length::SpaceMd)).pt(top).px(inline)
        } else {
            let top = if self.active {
                if look.cards {
                    ds.len(Length::Space2xl)
                } else {
                    ds.len(Length::TitlebarHeight) + px(DETAIL_ACTIVE_TOP)
                }
            } else {
                px(DETAIL_TOP)
            };
            pane.gap(ds.len(Length::SpaceLg))
                .pt(top)
                .px(px(DETAIL_INLINE))
        };
        let pane = pane.children(header).child(content);
        if look.cards && self.active && !look.compact {
            // The detail pane is a card under the title row, inset from the window.
            pane.mt(ds.len(Length::TitlebarHeight))
                .mr(ds.len(Length::ShellCardInset))
                .mb(ds.len(Length::ShellCardInset))
                .border(ds.len(Length::BorderHairline))
                .border_color(ds.color(Color::ShellCardEdge))
                .rounded(ds.len(Length::ShellCardRadius))
                .bg(ds.color(Color::ShellSettingsCardBg))
        } else {
            pane
        }
    }
}

impl RenderOnce for SettingsShell {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let compact = f32::from(window.viewport_size().width) <= COMPACT_MAX;
        let cards = scope::vars(cx).is_some_and(|vars| vars.cards_docked);
        let look = Look { compact, cards };
        let (direction, epoch) = page_direction(&self, window, cx);
        let clock = |name: String, window: &mut Window, cx: &mut App| {
            enter::progress(
                (self.id.clone(), name),
                (DsDuration::MotionBase, Easing::MotionEaseDecelerate),
                window,
                cx,
            )
        };
        let page_progress =
            (direction != Direction::None).then(|| clock(format!("page-{epoch}"), window, cx));
        let pane_progress =
            compact.then(|| clock(format!("pane-{:?}", self.compact_pane), window, cx));
        let ds = Ds::get(cx);
        let distance = f32::from(ds.len(Length::MotionDistanceMd));
        let enter_page = page_progress.map(|p| {
            (
                p,
                if direction == Direction::Forward {
                    distance
                } else {
                    -distance
                },
            )
        });
        let lane = f32::from(ds.len(Length::MotionDistanceLg));
        let id = self.id.clone();
        let mut sidebar = self.sidebar_pane(&look, ds);
        let mut detail = self.detail_pane(&look, ds, enter_page, &id);
        if let Some(progress) = pane_progress {
            match self.compact_pane {
                CompactPane::Master => sidebar = pane_moved(sidebar, progress, -lane),
                CompactPane::Detail => detail = pane_moved(detail, progress, lane),
            }
        }
        let mut shell = div()
            .id(self.id.clone())
            .relative()
            .flex()
            .size_full()
            .min_h_0()
            .overflow_hidden();
        if !cards {
            shell = shell.bg(ds.color(Color::SettingsBg));
        }
        shell = match (compact, self.compact_pane) {
            (false, _) => shell.child(sidebar).child(detail),
            (true, CompactPane::Master) => shell.child(sidebar),
            (true, CompactPane::Detail) => shell.child(detail),
        };
        if self.active {
            // The title-row drag lane over both panes.
            let height = if compact {
                Length::TitlebarSafeAreaTop
            } else {
                Length::TitlebarHeight
            };
            shell = shell.child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .right_0()
                    .h(ds.len(height))
                    .window_control_area(WindowControlArea::Drag),
            );
        }
        let rows = cards.then_some((Color::SidebarHoverBg, Color::SidebarSelectedBg));
        let spec = Spec {
            nav_fills: rows,
            ..Spec::default()
        };
        strut::scope(false, scope::scoped(spec, shell))
    }
}
