//! DS Skeleton and SkeletonRows (Skeleton.module.css, shadcn/ui/skeleton.tsx, SkeletonRows.tsx):
//! a calm placeholder block, `mix(--surface-raised 82%, --line)` with a sheen that sweeps across
//! it over `--shimmer-duration` (linear, looping). Reduced motion stops the sheen and the static
//! fill stays. Sized by a width (a fraction of the container or a number of `ch`), a height
//! token and a shape; `lines` is a paragraph with the DS width ramp.
use gpui::{
    App, ElementId, IntoElement, ParentElement as _, Pixels, RenderOnce, SharedString, Styled as _,
    Window, div, linear_color_stop, linear_gradient, point, px, relative,
};

use super::context::Ds;
use super::convert;
use super::motion::{Loop, Props, Timing, looping, mounted_at};
use crate::tokens::{Color, Duration as DsDuration, Length};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Width {
    Full,
    ThreeQuarters,
    TwoThirds,
    Half,
    TwoFifths,
    Third,
    Quarter,
    /// A number of `ch`, capped at the container's width.
    Ch(f32),
}

impl Width {
    fn fraction(self) -> Option<f32> {
        match self {
            Self::Full => Some(1.),
            Self::ThreeQuarters => Some(0.75),
            Self::TwoThirds => Some(0.66667),
            Self::Half => Some(0.5),
            Self::TwoFifths => Some(0.4),
            Self::Third => Some(0.33333),
            Self::Quarter => Some(0.25),
            Self::Ch(_) => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Height {
    /// A text line (`--skeleton-height-line`).
    Line,
    /// A heading line (`--skeleton-height-title`).
    Title,
    /// A control (`--control-height-lg`).
    Control,
    /// A list row (`--touch-target`).
    Row,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Shape {
    #[default]
    Rect,
    Pill,
    /// Fully rounded: a circle when its box is square (an ellipse in CSS when it is not; gpui
    /// corners are circular, so a stretched one has pill ends).
    Circle,
}

#[derive(IntoElement)]
pub struct Skeleton {
    id: ElementId,
    width: Option<Width>,
    height: Option<Height>,
    shape: Shape,
    lines: Option<usize>,
    aspect: Option<f32>,
    still: bool,
}

impl Skeleton {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            width: None,
            height: None,
            shape: Shape::Rect,
            lines: None,
            aspect: None,
            still: false,
        }
    }

    /// A full-width box of this width-to-height ratio (a picture's place).
    pub fn aspect(mut self, ratio: f32) -> Self {
        self.aspect = Some(ratio);
        self
    }

    pub fn width(mut self, width: Width) -> Self {
        self.width = Some(width);
        self
    }

    pub fn height(mut self, height: Height) -> Self {
        self.height = Some(height);
        self
    }

    pub fn shape(mut self, shape: Shape) -> Self {
        self.shape = shape;
        self
    }

    /// Inside a `data-motion="reduced"` scope: the sheen rests and only the fill shows.
    pub fn still(mut self) -> Self {
        self.still = true;
        self
    }

    /// A paragraph of this many lines with the DS width ramp (the width applies to none of them).
    pub fn lines(mut self, lines: usize) -> Self {
        self.lines = Some(lines);
        self
    }
}

/// How wide line `index` of `lines` is: long, medium, then a short last line.
fn paragraph_width(index: usize, lines: usize) -> f32 {
    if index + 1 == lines {
        0.46 // DS: Skeleton.module.css:93
    } else if index.is_multiple_of(2) {
        0.86 // DS: Skeleton.module.css:85
    } else {
        0.68 // DS: Skeleton.module.css:89
    }
}

/// The width of `0` in the inherited font, the `ch` unit.
fn ch(window: &mut Window) -> Pixels {
    let style = window.text_style();
    let size = style.font_size.to_pixels(window.rem_size());
    let font = window.text_system().resolve_font(&style.font());
    window
        .text_system()
        .advance(font, size, '0')
        .map_or(size * 0.5, |advance| advance.width)
}

impl RenderOnce for Skeleton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let unit = ch(window);
        if let Some(lines) = self.lines {
            let rows: Vec<_> = (0..lines)
                .map(|index| {
                    block(
                        &(self.id.clone(), index),
                        Look {
                            width: Fit::Fraction(paragraph_width(index, lines)),
                            height: self.height,
                            aspect: None,
                            shape: self.shape,
                            still: self.still,
                        },
                        window,
                        cx,
                    )
                })
                .collect();
            return div()
                .flex()
                .flex_col()
                .gap(Ds::get(cx).len(Length::SpaceSm))
                .children(rows)
                .into_any_element();
        }
        let width = match self.width {
            Some(Width::Ch(n)) => Fit::Chars(px(n * f32::from(unit))),
            Some(other) => other.fraction().map_or(Fit::Auto, Fit::Fraction),
            None => Fit::Auto,
        };
        block(
            &(self.id, 0),
            Look {
                width,
                height: self.height,
                aspect: self.aspect,
                shape: self.shape,
                still: self.still,
            },
            window,
            cx,
        )
        .into_any_element()
    }
}

/// How a block is made wide.
#[derive(Clone, Copy)]
enum Fit {
    Auto,
    Fraction(f32),
    Chars(Pixels),
}

#[derive(Clone, Copy)]
struct Look {
    width: Fit,
    height: Option<Height>,
    aspect: Option<f32>,
    shape: Shape,
    still: bool,
}

/// One placeholder block: the fill, the size rules and the sheen.
fn block(key: &(ElementId, usize), look: Look, window: &mut Window, cx: &mut App) -> gpui::Div {
    let ds = Ds::get(cx);
    let radius = match look.shape {
        Shape::Rect => ds.len(Length::RadiusControl),
        Shape::Pill | Shape::Circle => ds.len(Length::RadiusPill),
    };
    let mut el = div()
        .relative()
        .flex_none()
        .overflow_hidden()
        .rounded(radius)
        .bg(convert::mix(
            ds.color(Color::SurfaceRaised),
            ds.color(Color::Line),
            0.82, // DS: Skeleton.module.css:6
        ));
    el = match look.width {
        Fit::Auto => el,
        Fit::Fraction(f) => el.w(relative(f)),
        Fit::Chars(width) => el.w(width).max_w_full(),
    };
    if let Some(ratio) = look.aspect {
        // `width: 100%; min-height: 0; aspect-ratio`.
        el = el.w_full().aspect_ratio(ratio).min_h(px(0.));
    }
    el = match look.height {
        Some(Height::Line) => el.h(ds.len(Length::SkeletonHeightLine)),
        Some(Height::Title) => el.h(ds.len(Length::SkeletonHeightTitle)).min_h(px(16.)),
        Some(Height::Control) => el.h(ds.len(Length::ControlHeightLg)).min_h(px(16.)),
        Some(Height::Row) => el.h(ds.len(Length::TouchTarget)).min_h(px(16.)),
        None if look.aspect.is_some() => el,
        None => el.min_h(px(16.)), // DS: Skeleton.module.css:4 (1rem)
    };
    if Loop::Decorative.runs(ds) && !look.still {
        el = el.child(sheen(key, window, cx));
    }
    el
}

/// The sweep: a band as wide as the block that moves from -100% to 100% of the width, clear at
/// both edges and `mix(--surface 58%, transparent)` in the middle.
fn sheen(key: &(ElementId, usize), window: &mut Window, cx: &mut App) -> impl IntoElement {
    let ds = Ds::get(cx);
    let peak = convert::with_alpha(ds.color(Color::Surface), 0.58); // DS: Skeleton.module.css:30
    let clear = gpui::Hsla { alpha: 0., ..peak };
    let half = |angle: f32, from, to| {
        div().w(relative(0.5)).h_full().bg(linear_gradient(
            angle,
            linear_color_stop(from, 0.),
            linear_color_stop(to, 1.),
        ))
    };
    let timing = Timing::linear(ds.duration(DsDuration::ShimmerDuration));
    let id = SharedString::from(format!("{}-{}-sheen", key.0, key.1));
    looping(
        div()
            .absolute()
            .top_0()
            .left_0()
            .h_full()
            .w_full()
            .flex()
            .child(half(90., clear, peak))
            .child(half(90., peak, clear)),
        &timing,
        mounted_at(id, window, cx),
        false,
        &Props {
            relative_offset: Some((point(-1., 0.), point(1., 0.))),
            ..Default::default()
        },
    )
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RowsShape {
    /// List-row height bars.
    #[default]
    List,
    /// A label line above a control.
    Field,
}

#[derive(IntoElement)]
pub struct SkeletonRows {
    id: ElementId,
    rows: usize,
    shape: RowsShape,
}

impl SkeletonRows {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            rows: 3,
            shape: RowsShape::List,
        }
    }

    pub fn rows(mut self, rows: usize) -> Self {
        self.rows = rows;
        self
    }

    pub fn shape(mut self, shape: RowsShape) -> Self {
        self.shape = shape;
        self
    }
}

impl RenderOnce for SkeletonRows {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let gap = ds.len(match self.shape {
            RowsShape::List => Length::SpaceMd,
            RowsShape::Field => Length::SettingsFieldGap,
        });
        let bar = ds.len(Length::ControlHeightLg);
        let field_gap = ds.len(Length::SettingsFieldControlGap);
        let field_height = ds.len(Length::FontSize2);
        let rows = (0..self.rows).map(|row| {
            let mut cell = div().flex().flex_col().gap(field_gap);
            if self.shape == RowsShape::Field {
                // A label bar: 30% wide, one `--font-size-2` tall.
                let look = Look {
                    width: Fit::Fraction(0.3),
                    height: None,
                    aspect: None,
                    shape: Shape::Rect,
                    still: false,
                };
                cell = cell
                    .child(block(&(self.id.clone(), row * 2), look, window, cx).h(field_height));
            }
            let look = Look {
                width: Fit::Auto,
                height: None,
                aspect: None,
                shape: Shape::Rect,
                still: false,
            };
            cell.child(block(&(self.id.clone(), row * 2 + 1), look, window, cx).h(bar))
        });
        div().flex().flex_col().gap(gap).children(rows)
    }
}
