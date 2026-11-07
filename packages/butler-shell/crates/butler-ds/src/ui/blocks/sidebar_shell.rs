//! DS SidebarShell (SidebarShell.tsx / SidebarShell.module.css, hooks/useStickyClipping.ts): the
//! sidebar's column. A title row, a fixed header, a scroller with edge fades whose sticky header
//! pins under the top fade while the rows under it clip at its bottom edge, and a footer. Its
//! density sets the tokens of every row inside (touch at 640px and below).
use std::cell::RefCell;
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement as _, Pixels,
    RenderOnce, ScrollHandle, Styled as _, Window, div, px,
};

use super::anim::ramp;
use super::measure;
use super::scope::{self, Spec};
use crate::tokens::{Color, Density, Duration as DsDuration, Easing, Length};
use crate::ui::context::Ds;
use crate::ui::motion::Timing;
use crate::ui::scroll::engine::{self, Axis, Config};
use crate::ui::{convert, strut};

/// The scrollbar's lane past the rows (`--sidebar-scrollbar-offset`).
const SCROLLBAR_OFFSET: f32 = 10.; // DS: SidebarShell.module.css:2
/// The rows' gap in the scroller without a sticky header.
const ROW_GAP: f32 = 18.; // DS: SidebarShell.module.css:256
/// The collapsed content sits this far to the left.
const COLLAPSED_SHIFT: f32 = 18.; // DS: SidebarShell.module.css:127
/// The footer's top padding.
const FOOTER_TOP: f32 = 10.; // DS: SidebarShell.module.css:334

/// Where the shell publishes its scroller's handle each frame, for the caller to drive the
/// scroll: drag auto-scroll and scroll-to-reveal. Empty until the scroller has rendered.
pub type ScrollSlot = Rc<RefCell<Option<ScrollHandle>>>;

#[derive(IntoElement)]
pub struct SidebarShell {
    id: ElementId,
    density: Density,
    titlebar: Option<AnyElement>,
    header: Option<AnyElement>,
    scroll_header: Option<AnyElement>,
    sticky_header: Option<AnyElement>,
    footer: Option<AnyElement>,
    collapsed: bool,
    scroll_fade: bool,
    scroll_slot: Option<ScrollSlot>,
    children: Vec<AnyElement>,
}

impl SidebarShell {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            density: Density::Comfortable,
            titlebar: None,
            header: None,
            scroll_header: None,
            sticky_header: None,
            footer: None,
            collapsed: false,
            scroll_fade: true,
            scroll_slot: None,
            children: Vec::new(),
        }
    }

    /// Row height, inline padding, icon size, gaps and action targets of every row inside.
    pub fn density(mut self, density: Density) -> Self {
        self.density = density;
        self
    }

    pub fn titlebar(mut self, titlebar: impl IntoElement) -> Self {
        self.titlebar = Some(titlebar.into_any_element());
        self
    }

    pub fn header(mut self, header: impl IntoElement) -> Self {
        self.header = Some(header.into_any_element());
        self
    }

    /// Scrolls with the rows, above the sticky header.
    pub fn scroll_header(mut self, header: impl IntoElement) -> Self {
        self.scroll_header = Some(header.into_any_element());
        self
    }

    /// Pins under the top fade while the rows scroll; the rows under it clip at its bottom edge.
    pub fn sticky_header(mut self, header: impl IntoElement) -> Self {
        self.sticky_header = Some(header.into_any_element());
        self
    }

    pub fn footer(mut self, footer: impl IntoElement) -> Self {
        self.footer = Some(footer.into_any_element());
        self
    }

    pub fn collapsed(mut self, collapsed: bool) -> Self {
        self.collapsed = collapsed;
        self
    }

    pub fn scroll_fade(mut self, on: bool) -> Self {
        self.scroll_fade = on;
        self
    }

    /// Publishes the scroller's [`ScrollHandle`] into `slot`.
    pub fn scroll_slot(mut self, slot: ScrollSlot) -> Self {
        self.scroll_slot = Some(slot);
        self
    }
}

impl gpui::ParentElement for SidebarShell {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// The sticky header's offset and the clip of the rows under it, from how far the scroller has
/// scrolled (`scrolled`) and where the header sits in the content (`natural_top`): the header
/// holds at `stick_top` from the scrollport's top, and the rows hide behind its bottom edge.
fn sticky_offset(scrolled: f32, natural_top: f32, stick_top: f32) -> f32 {
    (scrolled + stick_top - natural_top).max(0.)
}

/// `.clippedContent`: the rows clipped by `clip` px at the top, with the focus-ring room left
/// open on the other edges (`clip-path: inset(clip -room -room)`). The wrapper pads the room
/// back with a negative margin so the rows keep their place.
fn clipped(rows: Vec<AnyElement>, clip: f32, room: Pixels) -> AnyElement {
    let inner = div()
        .flex()
        .flex_col()
        .min_w_0()
        .pt(room)
        .mt(px(-clip))
        .children(rows);
    div()
        .flex_auto()
        .min_w_0()
        .mx(-room)
        .mb(-room)
        .px(room)
        .pb(room)
        .mt(px(clip))
        .overflow_hidden()
        .child(inner)
        .into_any_element()
}

struct Parts {
    sticky: Option<AnyElement>,
    rows: Vec<AnyElement>,
    scroll_header: Option<AnyElement>,
}

/// What the scroller holds: the scroll header, the sticky header, then the rows.
fn scroll_content(shell: &mut SidebarShell, scrolled: f32, header_height: f32, ds: &Ds) -> Parts {
    let room = ds.len(Length::FocusRingRoom);
    let sticky = shell.sticky_header.take();
    let stick_top = f32::from(ds.len(Length::ScrollFadeSize) + room);
    let natural_top = f32::from(room) + header_height;
    let offset = sticky_offset(scrolled, natural_top, stick_top);
    let rows = std::mem::take(&mut shell.children);
    let (sticky, rows) = match sticky {
        Some(header) => {
            // `padding-bottom: calc(var(--space-sm) - var(--focus-ring-room))`
            let pinned = div()
                .relative()
                .top(px(offset))
                .flex_none()
                .pb((ds.len(Length::SpaceSm) - room).max(px(0.)))
                .child(header)
                .into_any_element();
            (Some(pinned), vec![clipped(rows, offset, room)])
        }
        None => (None, rows),
    };
    Parts {
        sticky,
        rows,
        scroll_header: shell.scroll_header.take(),
    }
}

impl SidebarShell {
    fn scroller(&mut self, window: &mut Window, cx: &mut App) -> AnyElement {
        let (header, recorder) = measure::track((self.id.clone(), "scroll-header"), window, cx);
        let ds = Ds::get(cx);
        let sticky = self.sticky_header.is_some();
        let (room, fade) = (
            ds.len(Length::FocusRingRoom),
            ds.len(Length::ScrollFadeSize),
        );
        let lane = px(SCROLLBAR_OFFSET);
        let config = Config {
            id: (self.id.clone(), "scroller").into(),
            axis: Axis::Y,
            size: if self.scroll_fade { fade } else { px(0.) },
            guard: px(0.),
        };
        let scrolled = scroll_position(&config, window, cx);
        let ds = Ds::get(cx);
        let parts = scroll_content(self, scrolled, f32::from(header.height), ds);
        let padded_header = parts.scroll_header.map(|header| {
            let el = div().relative().child(header).child(recorder);
            // The header keeps its room below it while a sticky header follows.
            if sticky {
                el.pb(ds.len(Length::Space2xl))
            } else {
                el
            }
        });
        let content = div()
            .flex()
            .flex_col()
            .w_full()
            .min_h_0()
            .gap(if sticky { px(0.) } else { px(ROW_GAP) })
            .py(room)
            .pl(room)
            .pr(lane)
            .children(padded_header)
            .children(parts.sticky)
            .children(parts.rows);
        let built = engine::scroller(&config, content.flex_none(), window, cx);
        if let Some(slot) = &self.scroll_slot {
            *slot.borrow_mut() = Some(built.handle.clone());
        }
        let thumb = convert::with_alpha(Ds::get(cx).color(Color::LineStrong), 0.7);
        let overlay = crate::ui::scroll::overlay(
            &(self.id.clone(), "scroll-bar").into(),
            &built,
            (Axis::Y, lane),
            thumb,
            window,
            cx,
        );
        div()
            .id((self.id.clone(), "scroll-frame"))
            .relative()
            .min_w_0()
            .min_h_0()
            .flex_auto()
            .overflow_hidden()
            .ml(-room)
            .mr(-lane)
            .my(-room)
            .child(built.element)
            .child(overlay)
            .into_any_element()
    }
}

/// How far the scroller has scrolled, from the handle its fade engine keeps.
fn scroll_position(config: &Config, window: &mut Window, cx: &mut App) -> f32 {
    let fade = engine::fade(config, None, false, window, cx);
    f32::from(-fade.handle.offset().y).max(0.)
}

fn title_row(titlebar: AnyElement, ds: &Ds, leading: f32) -> AnyElement {
    div()
        .flex()
        .flex_none()
        .items_center()
        .h(ds.len(Length::TitlebarHeight))
        .gap(ds.len(Length::Space2))
        .pl(px(leading))
        .child(titlebar)
        .into_any_element()
}

/// `--sidebar-titlebar-leading`: the toggle's left edge less the sidebar's inline padding, the
/// toggle and a gap: the title starts after the toggle (and the traffic lights).
fn titlebar_leading(ds: &Ds, cx: &App) -> f32 {
    match scope::vars(cx) {
        Some(vars) => {
            vars.chrome_toggle_left - f32::from(ds.len(Length::SidebarPaddingInline))
                + f32::from(ds.len(Length::ChromeFloatingToggleSize) + ds.len(Length::SpaceSm))
        }
        None => f32::from(ds.len(Length::SidebarTitlebarLeading)),
    }
}

impl RenderOnce for SidebarShell {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let density = self.density;
        let peek = scope::vars(cx).is_some_and(|vars| vars.sidebar_peek);
        // The density scopes the tokens the rows read, so build the body inside it.
        let svg_size = {
            let tokens = crate::tokens::TokenContext {
                density,
                ..*Ds::get(cx).tokens()
            };
            tokens.len(Length::SidebarIconSize)
        };
        let spec = Spec {
            density: Some(density),
            svg_size: Some(svg_size),
            ..Spec::default()
        };
        let shown = !self.collapsed || peek;
        let body = self.body(shown, window, cx);
        let ds = Ds::get(cx);
        let leading = titlebar_leading(ds, cx);
        let titlebar = self.titlebar.take().map(|bar| title_row(bar, ds, leading));
        let shell = div()
            .relative()
            .flex()
            .flex_col()
            .flex_auto()
            .w_full()
            .max_w_full()
            .min_w_0()
            .h_full()
            .min_h_0()
            .px(ds.len(Length::SidebarPaddingInline))
            .pb(ds.len(Length::SpaceLg))
            .overflow_hidden()
            .children(titlebar)
            .child(body);
        strut::scope(false, scope::scoped(spec, shell))
    }
}

impl SidebarShell {
    /// The column under the title row: it fades and slides out while collapsed.
    fn body(&mut self, shown: bool, window: &mut Window, cx: &mut App) -> AnyElement {
        let ds = Ds::get(cx);
        let base = |duration, ease| Timing::token(ds, duration, ease);
        let (opacity_in, opacity_out) = (
            base(DsDuration::MotionBase, Easing::MotionEaseStandard),
            base(DsDuration::MotionFast, Easing::MotionEaseStandard),
        );
        let (slide_in, slide_out) = (
            base(DsDuration::MotionSlow, Easing::MotionEaseEmphasized),
            base(DsDuration::MotionBase, Easing::MotionEaseEmphasized),
        );
        let target = f32::from(u8::from(shown));
        let jump = ds.reduced_motion();
        let (fade, slide) = if shown {
            (&opacity_in, &slide_in)
        } else {
            (&opacity_out, &slide_out)
        };
        let opacity = ramp(
            (self.id.clone(), "opacity"),
            (target, jump),
            fade,
            window,
            cx,
        );
        let slid = ramp(
            (self.id.clone(), "slide"),
            (target, false),
            slide,
            window,
            cx,
        );
        let ds = Ds::get(cx);
        let header = self
            .header
            .take()
            .map(|header| div().w_full().flex_none().child(header));
        let footer = self
            .footer
            .take()
            .map(|footer| div().w_full().flex_none().pt(px(FOOTER_TOP)).child(footer));
        let column = div()
            .relative()
            .flex()
            .flex_col()
            .flex_auto()
            .w_full()
            .min_w_0()
            .min_h_0()
            .gap(ds.len(Length::SpaceXs));
        if opacity <= 0.001 && !shown {
            return column.into_any_element();
        }
        let scroller = self.scroller(window, cx);
        column
            .left(px(-COLLAPSED_SHIFT * (1. - slid)))
            .opacity(opacity)
            .children(header)
            .child(scroller)
            .children(footer)
            .into_any_element()
    }
}

/// `SidebarTrafficSpace`: keeps the title row (a drag region) when it has no brand.
pub fn traffic_space() -> AnyElement {
    div().w(px(0.)).h_full().flex_none().into_any_element()
}

/// `SidebarNav`: a column of rows spaced by the density's row spacing.
pub fn nav(rows: impl IntoIterator<Item = AnyElement>, ds: &Ds) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .w_full()
        .min_w_0()
        .gap(ds.len(Length::SidebarRowSpacing))
        .children(rows)
        .into_any_element()
}

/// `SidebarBrand`: the product title row, the titlebar's height inside the title row and the
/// action height in the header.
pub fn brand(content: impl IntoElement, in_titlebar: bool, ds: &Ds) -> AnyElement {
    div()
        .flex()
        .items_center()
        .min_h(ds.len(if in_titlebar {
            Length::TitlebarHeight
        } else {
            Length::SidebarActionSize
        }))
        .child(content)
        .into_any_element()
}
