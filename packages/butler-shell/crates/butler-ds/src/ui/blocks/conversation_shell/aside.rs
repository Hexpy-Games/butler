//! The aside of ConversationShell (lib/AsideSlot.tsx, lib/asideLayout.ts, conversationAside.ts):
//! session details in the right margin. From a 960px shell it docks flat in the margin and the
//! column moves left; narrower it floats on TintedGlass over the conversation while open. Each
//! layout enters and leaves with a fade; its content has a scroller of its own.
use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement as _, ParentElement as _,
    SharedString, Styled as _, Window, div, px,
};
use std::rc::Rc;

use crate::tokens::{Duration as DsDuration, Easing, Length};
use crate::ui::blocks::anim::ramp;
use crate::ui::context::Ds;
use crate::ui::motion::Timing;
use crate::ui::scroll::engine::{self, Axis, Config};
use crate::ui::tinted_glass::{GlassPadding, GlassRadius, TintedGlass};

/// The shell width from which the aside docks in the right margin (a floating one docks again
/// 32px later).
pub const DOCK_MIN: f32 = 960.; // DS: conversationAside.ts:4
/// Room a floating aside needs past the dock line before it docks again.
const DOCK_HYSTERESIS: f32 = 32.; // DS: asideLayout.ts:7

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AsideLayout {
    Docked,
    Floating,
}

/// The next layout for `width`: docks from `min`, but a floating aside docks again only from
/// `min` plus the hysteresis, so a width on the line never flaps.
pub fn next_layout(current: Option<AsideLayout>, width: f32, min: f32) -> AsideLayout {
    let dock = match current {
        Some(AsideLayout::Docked) | None => width >= min,
        Some(AsideLayout::Floating) => width >= min + DOCK_HYSTERESIS,
    };
    if dock {
        AsideLayout::Docked
    } else {
        AsideLayout::Floating
    }
}

/// The shell's `data-aside`: docked moves the column; floating only while the glass panel shows.
pub fn shown(
    has_aside: bool,
    layout: Option<AsideLayout>,
    float_open: bool,
) -> Option<AsideLayout> {
    match (has_aside, layout) {
        (true, Some(AsideLayout::Docked)) => Some(AsideLayout::Docked),
        (true, Some(AsideLayout::Floating)) if float_open => Some(AsideLayout::Floating),
        _ => None,
    }
}

/// The aside's layout from the shell's width. `None` while disabled or not yet measured, so
/// nothing renders in the wrong place first; a closed aside forgets its layout.
pub(super) fn layout(
    id: &ElementId,
    (enabled, width): (bool, f32),
    window: &mut Window,
    cx: &mut App,
) -> Option<AsideLayout> {
    let state =
        window.use_keyed_state((id.clone(), "aside-layout"), cx, |_, _| None::<AsideLayout>);
    state.update(cx, |current, _| {
        *current = if !enabled || width <= 0. {
            None
        } else {
            Some(next_layout(*current, width, DOCK_MIN))
        };
        *current
    })
}

/// The aside's content: a node, or a function of the layout (content drops its own cards on glass).
pub type AsideContent = Rc<dyn Fn(AsideLayout) -> AnyElement>;
type Content = AsideContent;

pub(super) struct Slot {
    pub(super) id: ElementId,
    pub(super) content: Option<AsideContent>,
    pub(super) layout: Option<AsideLayout>,
    pub(super) float_open: bool,
    pub(super) top: f32,
    pub(super) composer_reserve: f32,
    /// How far the docked aside rides in with the column's glide.
    pub(super) glide: f32,
}

/// The aside's scroller: ring room, the shared edge fade, an inline inset on glass.
fn scroll(
    slot: &Slot,
    layout: AsideLayout,
    content: AnyElement,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let (room, fade) = (
        ds.len(Length::FocusRingRoom),
        ds.len(Length::ScrollFadeSize),
    );
    let side = match layout {
        AsideLayout::Docked => room,
        AsideLayout::Floating => ds.len(Length::SpaceMd).max(room),
    };
    let config = Config {
        id: ElementId::from((
            slot.id.clone(),
            SharedString::from(format!("scroll-{layout:?}")),
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
        .pl(side)
        .pr(side)
        .child(content);
    let built = engine::scroller(&config, body.min_w_0().flex_auto().min_h_0(), window, cx);
    let frame = div()
        .relative()
        .flex_auto()
        .min_w_0()
        .min_h_0()
        .overflow_hidden();
    match layout {
        AsideLayout::Docked => frame.mx(-room).child(built.element),
        AsideLayout::Floating => frame.child(built.element),
    }
    .into_any_element()
}

fn panel(
    slot: &Slot,
    (layout, on): (AsideLayout, bool),
    ds: &Ds,
    scroller: AnyElement,
    shell_w: f32,
) -> AnyElement {
    let mut aside = div().absolute().flex().flex_col().min_h_0();
    // The open aside takes the pointer over the conversation under it, as the topmost DOM box
    // does; a leaving one is inert (`AsideSlot`), so presses pass through it.
    if on {
        aside = aside.occlude();
    }
    let space = |token| f32::from(ds.len(token));
    match layout {
        AsideLayout::Docked => aside
            .top(px(slot.top))
            .right(px(space(Length::SpaceLg) - slot.glide))
            .bottom(px(space(Length::SpaceLg)))
            .w(px(super::column::ASIDE_WIDTH))
            .child(scroller)
            .into_any_element(),
        AsideLayout::Floating => {
            let wanted = super::column::ASIDE_WIDTH + 2. * space(Length::SpaceMd);
            let width = if shell_w > 0. {
                wanted.min(shell_w - 2. * space(Length::SpaceSm))
            } else {
                wanted
            };
            let bottom = (slot.composer_reserve - space(Length::SpaceSm)).max(0.);
            aside
                .top(px(slot.top))
                .right(ds.len(Length::SpaceSm))
                .bottom(px(bottom))
                .w(px(width))
                .child(floating_glass(scroller))
                .into_any_element()
        }
    }
}

/// The glass is the floating aside's only surface: it fills the panel, its scroller inside.
fn floating_glass(scroller: AnyElement) -> AnyElement {
    div()
        .size_full()
        .flex()
        .flex_col()
        .min_h_0()
        .child(
            TintedGlass::new()
                .radius(GlassRadius::Popover)
                .padding(GlassPadding::None)
                .child(div().flex().flex_col().h_full().min_h_0().child(scroller)),
        )
        .into_any_element()
}

/// The layout `layout` of the aside while it is wanted and for its exit fade after: the last
/// content stays for the exit.
fn layer(
    slot: &Slot,
    (layout, on): (AsideLayout, bool),
    shell_w: f32,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let kept = window.use_keyed_state((slot.id.clone(), "aside-kept"), cx, |_, _| None::<Content>);
    if let Some(content) = &slot.content {
        let content = content.clone();
        kept.update(cx, |kept, _| *kept = Some(content));
    }
    let ds = Ds::get(cx);
    let timing = if on {
        Timing::token(ds, DsDuration::MotionBase, Easing::MotionEaseDecelerate)
    } else {
        Timing::token(ds, DsDuration::MotionExitBase, Easing::MotionEaseAccelerate)
    };
    let name = SharedString::from(format!("aside-fade-{layout:?}"));
    let alpha = ramp(
        (slot.id.clone(), name),
        (f32::from(u8::from(on)), false),
        &timing,
        window,
        cx,
    );
    let content = kept.read(cx).clone().filter(|_| alpha > 0.001)?;
    let scroller = scroll(slot, layout, content(layout), window, cx);
    let panel = panel(slot, (layout, on), Ds::get(cx), scroller, shell_w);
    Some(
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .opacity(alpha)
            .child(panel)
            .into_any_element(),
    )
}

/// Both layouts as Presence fades; the last content stays for the exit.
pub(super) fn render(
    slot: &Slot,
    shell_w: f32,
    window: &mut Window,
    cx: &mut App,
) -> Vec<AnyElement> {
    let present = slot.content.is_some();
    let docked = present && slot.layout == Some(AsideLayout::Docked);
    let floating = present && slot.layout == Some(AsideLayout::Floating) && slot.float_open;
    [
        (AsideLayout::Docked, docked),
        (AsideLayout::Floating, floating),
    ]
    .into_iter()
    .filter_map(|which| layer(slot, which, shell_w, window, cx))
    .collect()
}
