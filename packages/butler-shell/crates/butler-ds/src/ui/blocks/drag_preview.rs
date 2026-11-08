//! DS DragPreview (DragPreview.tsx / DragPreview.module.css): what follows the pointer while
//! picked elements or a browser tab are dragged: two stacked crops with a count, or the lifted
//! tab, with a no-entry badge over invalid targets, lifted on `--shadow-drag-lift`. It renders
//! static (a story) or floating at `at`, just below and right of the pointer's tip on `--z-drag`.
//!
//! gpui draws an element in one orientation, so the crops and the tab do not take the slight
//! turns (-4 deg, 6 deg, -1.5 deg) the React preview gives them.
use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement, Pixels, Point, RenderOnce,
    SharedString, Styled as _, Window, canvas, div, point, px,
};

use crate::tokens::{Color, Duration as DsDuration, Easing, Length, Number, Shadow};
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::icon::{IconSize, icon};
use crate::ui::layer::{Layer, Z};
use crate::ui::motion::{Props, Timing, transition};

/// A picked element's crop: its intrinsic size (it never scales up) and a painter that draws it
/// at the scale the matte fits it to (gpui has no image box that scales its children).
pub struct DragPreviewImage {
    width: f32,
    height: f32,
    paint: Box<dyn FnOnce(f32) -> AnyElement>,
}

impl DragPreviewImage {
    pub fn new(width: f32, height: f32, paint: impl FnOnce(f32) -> AnyElement + 'static) -> Self {
        Self {
            width,
            height,
            paint: Box::new(paint),
        }
    }
}

enum Kind {
    Elements {
        images: Vec<DragPreviewImage>,
        count: Option<u32>,
    },
    Tab {
        title: SharedString,
        icon: Option<AnyElement>,
    },
}

/// Where a floating preview is placed.
#[derive(Clone, Copy, Debug)]
pub enum Floating {
    /// `fixed`: window pixels (the pointer position).
    Fixed(Point<Pixels>),
    /// `absolute`: the pixels of the positioned layer around it.
    Absolute(Point<Pixels>),
}

#[derive(IntoElement)]
pub struct DragPreview {
    id: ElementId,
    kind: Kind,
    invalid: bool,
    at: Option<Floating>,
}

/// The stack's box and a crop's side.
const STACK: (f32, f32) = (76., 64.); // DS: DragPreview.module.css:3
const CROP: f32 = 60.; // DS: DragPreview.module.css:16
/// The tab's width.
const TAB_WIDTH: f32 = 190.; // DS: DragPreview.module.css:116
/// The back crop's offset and the badge's left edge.
const BADGE_LEFT: f32 = 56.; // DS: DragPreview.module.css:96

impl DragPreview {
    /// Picked page elements, stacked: the first two images, `count` in the badge (default: the
    /// number of images).
    pub fn elements(id: impl Into<ElementId>, images: Vec<DragPreviewImage>) -> Self {
        Self {
            id: id.into(),
            kind: Kind::Elements {
                images,
                count: None,
            },
            invalid: false,
            at: None,
        }
    }

    pub fn count(mut self, count: u32) -> Self {
        if let Kind::Elements { count: slot, .. } = &mut self.kind {
            *slot = Some(count);
        }
        self
    }

    /// A browser tab lifted out of the strip, with its site icon (a globe when missing).
    pub fn tab(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            kind: Kind::Tab {
                title: title.into(),
                icon: None,
            },
            invalid: false,
            at: None,
        }
    }

    pub fn tab_icon(mut self, site_icon: impl IntoElement) -> Self {
        if let Kind::Tab { icon, .. } = &mut self.kind {
            *icon = Some(site_icon.into_any_element());
        }
        self
    }

    /// Over a target that cannot take it: the no-entry badge replaces the count.
    pub fn invalid(mut self, invalid: bool) -> Self {
        self.invalid = invalid;
        self
    }

    /// Floating mode: the pointer, updated on every move.
    pub fn at(mut self, at: Floating) -> Self {
        self.at = Some(at);
        self
    }
}

/// The no-entry badge: a circle with a bar (12px, stroke 1.6).
fn no_entry(color: gpui::Hsla) -> AnyElement {
    let bar = canvas(
        |_, _, _| (),
        move |bounds, (), window, _| {
            let mut path = gpui::PathBuilder::stroke(px(1.6));
            path.move_to(bounds.origin + point(px(2.8), px(9.2)));
            path.line_to(bounds.origin + point(px(9.2), px(2.8)));
            if let Ok(path) = path.build() {
                window.paint_path(path, color);
            }
        },
    )
    .absolute()
    .size_full();
    div()
        .relative()
        .size(px(12.))
        .child(
            div()
                .absolute()
                .top(px(1.5))
                .left(px(1.5))
                .size(px(9.))
                .rounded_full()
                .border(px(1.6))
                .border_color(color),
        )
        .child(bar)
        .into_any_element()
}

/// `.badge`: the count, or the no-entry mark when invalid, on the top-end corner.
fn badge(text: Option<SharedString>, invalid: bool, tab: bool, ds: &Ds) -> Div {
    let side = ds.len(Length::SpaceXl) + ds.len(Length::BorderWidthStrong);
    let raised = ds.color(Color::SurfaceRaised);
    let mut badge = div()
        .absolute()
        .top(-ds.len(Length::SpaceSm))
        .min_w(side)
        .h(side)
        .px(ds.len(Length::SpaceXs))
        .flex()
        .items_center()
        .justify_center()
        .border(ds.len(Length::BorderWidthStrong))
        .border_color(raised)
        .rounded(ds.len(Length::RadiusPill))
        .bg(ds.color(if invalid {
            Color::ColorDanger
        } else {
            Color::Accent
        }))
        .text_color(ds.color(Color::NeutralWhite))
        .text_size(ds.len(Length::FontSize1))
        .line_height(ds.len(Length::TypoCaptionLineHeight))
        .font_weight(gpui::FontWeight(ds.number(Number::FontWeightStrong)));
    let edge = ds.len(Length::SpaceSm);
    badge = match (invalid, tab) {
        (true, false) => badge.left(-edge),
        (_, true) => badge.right(-edge),
        (false, false) => badge.left(px(BADGE_LEFT)),
    };
    if invalid {
        badge.child(no_entry(ds.color(Color::NeutralWhite)))
    } else {
        badge.children(text)
    }
}

use gpui::Div;

/// One crop, whole on a neutral matte (contain: never cut mid-glyph, never scaled up).
fn crop(image: DragPreviewImage, left: Pixels, ds: &Ds) -> Div {
    let inner = CROP - 2. * f32::from(ds.len(Length::BorderWidthStrong));
    let fit = (inner / image.width).min(inner / image.height).min(1.);
    div()
        .absolute()
        .top_0()
        .left(left)
        .flex()
        .items_center()
        .justify_center()
        .size(px(CROP))
        .p(ds.len(Length::BorderWidthStrong))
        .overflow_hidden()
        .rounded(ds.len(Length::RadiusControl))
        .bg(ds.color(Color::SurfaceRaised))
        .shadow(convert::box_shadows(
            ds.tokens().shadow(Shadow::ShadowDragLift),
            ds.tokens(),
        ))
        .child(
            div()
                .w(px(image.width * fit))
                .h(px(image.height * fit))
                .overflow_hidden()
                .rounded(ds.len(Length::RadiusControl) - ds.len(Length::BorderWidthStrong))
                .child((image.paint)(fit)),
        )
}

fn stack(images: Vec<DragPreviewImage>, count: Option<u32>, invalid: bool, ds: &Ds) -> AnyElement {
    let total = count.unwrap_or_else(|| u32::try_from(images.len()).unwrap_or(u32::MAX));
    let mut shown: Vec<_> = images.into_iter().take(2).collect();
    shown.reverse();
    let single = shown.len() == 1;
    let layers = shown.into_iter().enumerate().map(|(index, image)| {
        let back = !single && index == 0;
        crop(
            image,
            if back {
                ds.len(Length::SpaceMd)
            } else {
                px(0.)
            },
            ds,
        )
    });
    let text = (total > 1).then(|| {
        SharedString::from(if total > 99 {
            "99+".to_owned()
        } else {
            total.to_string()
        })
    });
    div()
        .relative()
        .w(px(STACK.0))
        .h(px(STACK.1))
        .children(layers)
        .children((invalid || text.is_some()).then(|| badge(text, invalid, false, ds)))
        .into_any_element()
}

fn lifted_tab(title: SharedString, site: Option<AnyElement>, invalid: bool, ds: &Ds) -> AnyElement {
    let favicon = site.unwrap_or_else(|| icon(Icon::Globe2, IconSize::Md, ds).into_any_element());
    div()
        .relative()
        .flex()
        .items_center()
        .w(px(TAB_WIDTH))
        .h(ds.len(Length::ControlHeightMd))
        .gap(ds.len(Length::SpaceSm))
        .pl(ds.len(Length::SpaceSm))
        .pr(ds.len(Length::SpaceMd))
        .rounded(ds.len(Length::RadiusControl))
        .bg(ds.color(Color::SurfaceRaised))
        .shadow(convert::box_shadows(
            ds.tokens().shadow(Shadow::ShadowDragLift),
            ds.tokens(),
        ))
        .text_color(ds.color(Color::TextPrimary))
        .text_size(ds.len(Length::FontSize2))
        .line_height(ds.len(Length::TypoLabelLineHeight))
        .child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(ds.len(Length::IconSizeMd))
                .text_color(ds.color(Color::TextTertiary))
                .child(favicon),
        )
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(title),
        )
        .children(invalid.then(|| badge(None, true, true, ds)))
        .into_any_element()
}

impl RenderOnce for DragPreview {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let body = match self.kind {
            Kind::Elements { images, count } => stack(images, count, self.invalid, ds),
            Kind::Tab { title, icon } => lifted_tab(title, icon, self.invalid, ds),
        };
        let Some(at) = self.at else {
            return body;
        };
        let lifted = ds.number(Number::MotionScaleLift);
        let timing = Timing::token(ds, DsDuration::MotionFast, Easing::MotionEaseEmphasized);
        let jump = ds.reduced_motion();
        let (pad_top, pad_left) = (ds.len(Length::SpaceMd), ds.len(Length::SpaceMd));
        let progress = transition((self.id.clone(), "lift"), (1., jump), &timing, window, cx);
        let body = progress.apply(
            div().pt(pad_top).pl(pad_left).child(body),
            &timing,
            &Props {
                opacity: Some((0., 1.)),
                scale: Some((lifted, 1.)),
                ..Default::default()
            },
        );
        match at {
            Floating::Fixed(pointer) => Layer::new(Z::Drag, pointer, body).into_any_element(),
            Floating::Absolute(pointer) => div()
                .absolute()
                .left(pointer.x)
                .top(pointer.y)
                .child(body)
                .into_any_element(),
        }
    }
}
