//! The aside of ManagementPage (ManagementPage.module.css `.aside`, lib/AsideSlot.tsx,
//! lib/asideLayout.ts): a detail beside the content. From a 1000px page it docks flat in the right
//! margin; narrower it floats on TintedGlass over the page while open. Its content has a scroller
//! of its own.
// ANIM-MIGRATE(the aside's Presence fade on open, close and a docked/floating flip; it shows its
// end state at once)
use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement as _, ParentElement as _,
    SharedString, Styled as _, Window, div, px,
};

use crate::tokens::Length;
use crate::ui::blocks::conversation_shell::{AsideContent, AsideLayout, next_layout};
use crate::ui::context::Ds;
use crate::ui::scroll::engine::{self, Axis, Config};
use crate::ui::tinted_glass::{GlassPadding, GlassRadius, TintedGlass};

/// The page width from which the aside docks beside the content (a floating one docks again 32px
/// later).
pub const DOCK_MIN: f32 = 1000.; // DS: ManagementPage.tsx:13
/// `--management-aside-width`.
const WIDTH: f32 = 360.; // DS: ManagementPage.module.css:2

/// `--management-aside-keep-out`: what the content and an overlay footer keep clear of.
pub(super) fn keep_out(ds: &Ds) -> f32 {
    WIDTH + f32::from(ds.len(Length::SpaceLg)) + f32::from(ds.len(Length::Space2xl))
}

/// The aside's layout from the page's width. `None` while there is no aside or the page is not
/// yet measured, so nothing renders in the wrong place first.
pub(super) fn layout(
    id: &ElementId,
    (enabled, width): (bool, f32),
    window: &mut Window,
    cx: &mut App,
) -> Option<AsideLayout> {
    let state =
        window.use_keyed_state((id.clone(), "aside-layout"), cx, |_, _| None::<AsideLayout>);
    state.update(cx, |current, _| {
        *current = if enabled && width > 0. {
            Some(next_layout(*current, width, DOCK_MIN))
        } else {
            None
        };
        *current
    })
}

pub(super) struct Slot {
    pub(super) id: ElementId,
    pub(super) content: AsideContent,
    pub(super) layout: AsideLayout,
    pub(super) label: Option<SharedString>,
    /// `--footer-reserve + 22px + safe area + keyboard`: how far above the page's bottom a
    /// floating aside ends.
    pub(super) bottom: f32,
}

/// The aside's scroller: ring room, the shared edge fade, an inline inset on glass.
fn scroll(slot: &Slot, content: AnyElement, window: &mut Window, cx: &mut App) -> AnyElement {
    let ds = Ds::get(cx);
    let (room, fade) = (
        ds.len(Length::FocusRingRoom),
        ds.len(Length::ScrollFadeSize),
    );
    let side = match slot.layout {
        AsideLayout::Docked => room,
        AsideLayout::Floating => ds.len(Length::SpaceMd).max(room), // DS: AsideSlot.module.css:36
    };
    let config = Config {
        id: ElementId::from((
            slot.id.clone(),
            SharedString::from(format!("scroll-{:?}", slot.layout)),
        )),
        axis: Axis::Y,
        size: fade,
        guard: px(0.),
    };
    let body = div()
        .flex()
        .flex_col()
        .w_full()
        .flex_none()
        .py(fade)
        .px(side)
        .child(content);
    let built = engine::scroller(&config, body.min_w_0().flex_auto().min_h_0(), window, cx);
    let frame = div()
        .relative()
        .flex_auto()
        .min_w_0()
        .min_h_0()
        .overflow_hidden();
    match slot.layout {
        AsideLayout::Docked => frame.mx(-room).child(built.element),
        AsideLayout::Floating => frame.child(built.element),
    }
    .into_any_element()
}

/// The aside for `page` (width, height): flat in the margin, or one glass panel over the page.
pub(super) fn render(
    slot: &Slot,
    (page_w, page_h): (f32, f32),
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let scroller = scroll(slot, (slot.content)(slot.layout), window, cx);
    let ds = Ds::get(cx);
    let space = |token| f32::from(ds.len(token));
    let id = slot.label.clone().map_or_else(
        || ElementId::from((slot.id.clone(), "aside")),
        ElementId::from,
    );
    let top = space(Length::SpaceLg);
    // The open aside takes the pointer over the page under it.
    let aside = div()
        .id(id)
        .absolute()
        .occlude()
        .flex()
        .flex_col()
        .min_h_0()
        .top(px(top));
    match slot.layout {
        AsideLayout::Docked => aside
            .right(px(top))
            .bottom(px(top))
            .w(px(WIDTH))
            .child(scroller)
            .into_any_element(),
        AsideLayout::Floating => {
            let side = space(Length::SpaceSm);
            let wanted = WIDTH + 2. * space(Length::SpaceMd);
            let width = if page_w > 0. {
                wanted.min(page_w - 2. * side)
            } else {
                wanted
            };
            // `.asideGlass { height: 100% }`: the glass fills the panel between its insets.
            let height = (page_h - top - slot.bottom).max(0.);
            aside
                .right(px(side))
                .bottom(px(slot.bottom))
                .w(px(width))
                .child(glass(scroller, height))
                .into_any_element()
        }
    }
}

/// The glass is the floating aside's only surface: it fills the panel, its scroller inside.
fn glass(scroller: AnyElement, height: f32) -> AnyElement {
    div()
        .size_full()
        .flex()
        .flex_col()
        .min_h_0()
        .child(
            TintedGlass::new()
                .radius(GlassRadius::Popover)
                .padding(GlassPadding::None)
                .height(px(height))
                .child(div().flex().flex_col().h_full().min_h_0().child(scroller)),
        )
        .into_any_element()
}
