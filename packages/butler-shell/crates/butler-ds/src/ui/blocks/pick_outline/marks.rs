//! The marks of a PickOutline: the keylined outlines, the hover tag and the index badges.
use gpui::{
    AnyElement, App, Div, ElementId, Hsla, IntoElement as _, ParentElement as _, SharedString,
    Styled as _, Window, div, px, relative,
};

use super::PickRect;
use crate::tokens::{Color, Duration as DsDuration, Easing, Length, Number, Shadow};
use crate::ui::context::Ds;
use crate::ui::convert::box_shadows;
use crate::ui::motion::{self, Props, Timing};
use crate::ui::typo::{Role, Tone, Typo, Wrap};

/// Room the hover tag needs above its outline; with less, the tag sits inside the outline.
const TAG_ROOM: f32 = 26.; // DS: PickOutline.tsx:33
/// A hover outline ending closer than this to the layer's start starts its tag at the outline.
const TAG_START: f32 = 180.; // DS: PickOutline.tsx:35
/// Half the index badge: a pick at the layer's edge keeps its whole badge inside the layer.
const BADGE_HALF: f32 = 11.; // DS: PickOutline.tsx:37
/// `scale: 0.6` of `pick-pop`.
const POP_FROM: f32 = 0.6; // DS: PickOutline.module.css:127

/// The layer the marks sit in.
pub(super) struct Layer {
    pub id: ElementId,
    pub width: f32,
    pub height: f32,
    /// No fade and no pop.
    pub still: bool,
}

/// A rect in layer pixels.
#[derive(Clone, Copy)]
pub(super) struct Scaled {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

impl Scaled {
    pub(super) fn new(rect: PickRect, scale: f32) -> Self {
        Self {
            x: rect.x * scale,
            y: rect.y * scale,
            w: rect.width * scale,
            h: rect.height * scale,
        }
    }
}

fn len(ds: &Ds, token: Length) -> f32 {
    f32::from(ds.len(token))
}

/// `.hover` / `.picked`: the ink stroke between a keyline outside the box and one just inside the
/// stroke (`box-shadow: 0 0 0 hairline keyline, inset 0 0 0 hairline keyline`).
fn outline(rect: Scaled, dashed: bool, tint: Option<Hsla>, ds: &Ds) -> Div {
    let (hair, strong) = (
        len(ds, Length::BorderHairline),
        len(ds, Length::BorderWidthStrong),
    );
    let radius = len(ds, Length::RadiusControl) / 2.; // DS: PickOutline.module.css:21
    let keyline = ds.color(Color::BrowserPickKeyline);
    let ring = |inset: f32, radius: f32| {
        div()
            .absolute()
            .left(px(inset))
            .top(px(inset))
            .w(px((rect.w - 2. * inset).max(0.)))
            .h(px((rect.h - 2. * inset).max(0.)))
            .border(px(hair))
            .border_color(keyline)
            .rounded(px(radius.max(0.)))
    };
    let mut stroke = div()
        .absolute()
        .left(px(0.))
        .top(px(0.))
        .size_full()
        .border(px(strong))
        .border_color(ds.color(Color::BrowserPickInk))
        .rounded(px(radius));
    if dashed {
        stroke = stroke.border_dashed();
    }
    if let Some(tint) = tint {
        stroke = stroke.bg(tint);
    }
    div()
        .absolute()
        .left(px(rect.x))
        .top(px(rect.y))
        .w(px(rect.w))
        .h(px(rect.h))
        .child(ring(-hair, radius + hair))
        .child(stroke)
        .child(ring(strong, radius - strong))
}

/// A picked element: the solid, tinted outline.
pub(super) fn picked(_: &Layer, rect: Scaled, ds: &Ds) -> AnyElement {
    let tint = ds.color(Color::BrowserPickTint);
    outline(rect, false, Some(tint), ds).into_any_element()
}

/// The element under the pointer: the dashed outline and its tag, fading in once.
pub(super) fn hover(
    layer: &Layer,
    (rect, label): (Scaled, Option<SharedString>),
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let tag = label.map(|label| tag(layer, rect, label, ds));
    let group = div()
        .absolute()
        .left(px(0.))
        .top(px(0.))
        .size_full()
        .child(outline(rect, true, None, ds))
        .children(tag);
    if layer.still {
        return group.into_any_element();
    }
    let timing = Timing::token(ds, DsDuration::MotionFast, Easing::MotionEaseStandard);
    let props = Props {
        opacity: Some((0., 1.)),
        ..Props::default()
    };
    motion::enter(
        (layer.id.clone(), "hover"),
        &timing,
        &props,
        group,
        window,
        cx,
    )
    .into_any_element()
}

/// `.tag`: element and size, above the outline's end, inside it at the layer's top edge.
fn tag(layer: &Layer, rect: Scaled, label: SharedString, ds: &Ds) -> Div {
    let (hair, strong, room) = (
        len(ds, Length::BorderHairline),
        len(ds, Length::BorderWidthStrong),
        len(ds, Length::SpaceXs),
    );
    let below = rect.y < TAG_ROOM;
    let start = rect.x + rect.w < TAG_START;
    // The tag's offsets are from the outline's padding box (inside its stroke).
    let horizontal = |el: Div| match (start, below) {
        (true, false) => el.left(px(rect.x)),
        (true, true) => el.left(px(rect.x + strong + room)),
        (false, false) => el.right(px(layer.width - (rect.x + rect.w))),
        (false, true) => el.right(px(layer.width - (rect.x + rect.w - strong - room))),
    };
    let vertical = |el: Div| {
        if below {
            el.top(px(rect.y + strong + room))
        } else {
            el.bottom(px(layer.height - (rect.y + strong - room)))
        }
    };
    let tag = div()
        .absolute()
        .px(ds.len(Length::SpaceSm))
        .py(px(1.)) // DS: PickOutline.module.css:41
        .border(px(hair))
        .border_color(ds.color(Color::BrowserPickKeyline))
        .rounded(ds.len(Length::RadiusPill))
        .bg(ds.color(Color::BrowserPickInk))
        .shadow(box_shadows(
            ds.tokens().shadow(Shadow::BrowserOverlayShadow),
            ds.tokens(),
        ))
        .text_color(ds.color(Color::NeutralWhite))
        .text_size(ds.len(Length::FontSize1))
        .line_height(ds.len(Length::TypoCaptionLineHeightTight))
        .font_weight(gpui::FontWeight(ds.number(Number::FontWeightSemibold)))
        .child(
            Typo::new(Role::Text, label)
                .tabular()
                .tone(Tone::Inherit)
                .wrap(Wrap::Nowrap),
        );
    vertical(horizontal(tag))
}

/// `.badge`: the pick order, centred on the outline's top-start corner and kept inside the
/// layer; it pops in once per pick.
pub(super) fn badge(
    layer: &Layer,
    (id, number, rect): (&SharedString, usize, Scaled),
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let size = len(ds, Length::SpaceXl) + len(ds, Length::BorderWidthStrong);
    let clamp = |at: f32, extent: f32| at.max(BADGE_HALF).min(extent - BADGE_HALF);
    let (x, y) = (clamp(rect.x, layer.width), clamp(rect.y, layer.height));
    let text = if number > 99 {
        "99+".to_owned()
    } else {
        number.to_string()
    };
    let badge = div()
        .absolute()
        .left(px(x - size / 2.))
        .top(px(y - size / 2.))
        .flex()
        .items_center()
        .justify_center()
        .min_w(px(size))
        .h(px(size))
        .px(ds.len(Length::SpaceXs))
        .border(ds.len(Length::BorderWidthStrong))
        .border_color(ds.color(Color::BrowserPickKeyline))
        .rounded(ds.len(Length::RadiusPill))
        .bg(ds.color(Color::BrowserPickInk))
        .shadow(box_shadows(
            ds.tokens().shadow(Shadow::BrowserOverlayShadow),
            ds.tokens(),
        ))
        .text_color(ds.color(Color::NeutralWhite))
        .text_size(ds.len(Length::FontSize1))
        .line_height(relative(1.))
        .font_weight(gpui::FontWeight(ds.number(Number::FontWeightStrong)))
        .child(Typo::new(Role::Text, text).tabular().tone(Tone::Inherit));
    if layer.still {
        return badge.into_any_element();
    }
    let timing = Timing::token(ds, DsDuration::MotionBase, Easing::MotionEaseEmphasized);
    let props = Props {
        opacity: Some((0., 1.)),
        scale: Some((POP_FROM, 1.)),
        ..Props::default()
    };
    let key = (layer.id.clone(), id.clone());
    motion::enter(key, &timing, &props, badge, window, cx).into_any_element()
}
