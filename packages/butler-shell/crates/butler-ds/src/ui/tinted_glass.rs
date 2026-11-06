//! DS TintedGlass (TintedGlass.tsx / TintedGlass.module.css): the surface every overlay uses.
//! A translucent base with an opaque tint in the middle and 20px edge fades, a hairline border,
//! the soft shadow with an inset top highlight, over `blur(4px)` of what is behind.
use gpui::{
    AnyElement, App, Bounds, ContentMask, Corners, Edges, Filter, Hsla, IntoElement, ParentElement,
    Pixels, RenderOnce, Styled as _, Window, canvas, div, linear_color_stop, linear_gradient, px,
};

use super::context::Ds;
use super::convert;
use super::strut;
use crate::tokens::{Color, Length, Shadow};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum GlassRadius {
    Control,
    #[default]
    Panel,
    Popover,
    Composer,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum GlassPadding {
    None,
    Sm,
    #[default]
    Md,
    Lg,
}

/// Everything the paint pass needs, resolved from tokens at render time.
#[derive(Clone)]
struct Paint {
    radius: Pixels,
    /// The top corners are square (a sheet that hangs from the top edge).
    square_top: bool,
    border: Hsla,
    base: Hsla,
    tint: Hsla,
    edge: Pixels,
    shadow: Vec<gpui::BoxShadow>,
    highlight: gpui::BoxShadow,
    blur: Pixels,
}

#[derive(IntoElement)]
pub struct TintedGlass {
    radius: GlassRadius,
    padding: GlassPadding,
    square_top: bool,
    height: Option<Pixels>,
    children: Vec<AnyElement>,
}

impl TintedGlass {
    pub fn new() -> Self {
        Self {
            radius: GlassRadius::Panel,
            padding: GlassPadding::Md,
            square_top: false,
            height: None,
            children: Vec::new(),
        }
    }

    pub fn radius(mut self, radius: GlassRadius) -> Self {
        self.radius = radius;
        self
    }

    pub fn padding(mut self, padding: GlassPadding) -> Self {
        self.padding = padding;
        self
    }

    /// Only the bottom corners are rounded (`border-radius: 0 0 r r`).
    pub fn square_top(mut self) -> Self {
        self.square_top = true;
        self
    }

    /// A definite height (`height: <length>`), which the content may then fill with `h_full`.
    pub fn height(mut self, height: Pixels) -> Self {
        self.height = Some(height);
        self
    }
}

impl Default for TintedGlass {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for TintedGlass {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// `inset 0 1px 0 var(--tinted-glass-highlight)`.
fn highlight(ds: &Ds) -> gpui::BoxShadow {
    gpui::BoxShadow {
        color: ds.color(Color::TintedGlassHighlight).into(),
        offset: gpui::point(px(0.), px(1.)), // DS: TintedGlass.module.css:23
        blur_radius: px(0.),
        spread_radius: px(0.),
        inset: true,
    }
}

impl Paint {
    fn new(ds: &Ds, radius: Pixels, square_top: bool) -> Self {
        Self {
            radius,
            square_top,
            border: ds.color(Color::TintedGlassBorder),
            base: ds.color(Color::TintedGlassBg),
            tint: ds.color(Color::TintedGlassTint),
            edge: ds.len(Length::TintedGlassEdgeSize),
            shadow: convert::box_shadows(
                ds.tokens().shadow(Shadow::TintedGlassShadow),
                ds.tokens(),
            ),
            highlight: highlight(ds),
            // --tinted-glass-filter: saturate(1.35) blur(4px).
            // TODO(gpui-ce saturate): gpui-ce e5cdb0c has no saturation stage, so
            // `saturate(1.35)` of TintedGlass.module.css:20 is left out; only the blur is drawn.
            blur: ds.len(Length::TintedGlassBlur),
        }
    }

    fn corners(&self, radius: Pixels) -> Corners<Pixels> {
        let top = if self.square_top { px(0.) } else { radius };
        Corners {
            top_left: top,
            top_right: top,
            bottom_left: radius,
            bottom_right: radius,
        }
    }

    fn paint(&self, bounds: Bounds<Pixels>, window: &mut Window) {
        let r = self
            .radius
            .min(bounds.size.width / 2.)
            .min(bounds.size.height / 2.);
        let radii = self.corners(r);
        window.paint_drop_shadows_outside(bounds, radii, 0., &self.shadow);
        window.paint_backdrop_filter(bounds, radii, 0., &[Filter::Blur(self.blur)]);
        window.paint_quad(
            gpui::PaintQuad::new(bounds)
                .background(self.base)
                .corner_radii(radii),
        );
        self.paint_tint(bounds, r, window);
        window.paint_inset_shadows(bounds, radii, 0., std::slice::from_ref(&self.highlight));
        window.paint_quad(
            gpui::PaintQuad::new(bounds)
                .corner_radii(radii)
                .border_widths(Edges::all(px(1.))) // DS: TintedGlass.module.css:5
                .border_color(self.border),
        );
    }

    /// The tint layers, in the padding box: a fade from clear to the tint over the edge size at
    /// the top, the same at the bottom, and the opaque tint between. Two full-height gradients,
    /// each clipped to its half, give all three.
    fn paint_tint(&self, bounds: Bounds<Pixels>, radius: Pixels, window: &mut Window) {
        let border = px(1.); // DS: TintedGlass.module.css:5
        let inner = Bounds::new(
            bounds.origin + gpui::point(border, border),
            bounds.size - gpui::size(border * 2., border * 2.),
        );
        let radii = self.corners((radius - border).max(px(0.)));
        let edge = self.edge.min(inner.size.height / 2.);
        let stop = edge / inner.size.height.max(px(1.));
        let clear = Hsla {
            alpha: 0.,
            ..self.tint
        };
        let half = inner.size.height / 2.;
        for (angle, top) in [(180., true), (0., false)] {
            let gradient = linear_gradient(
                angle,
                linear_color_stop(clear, 0.),
                linear_color_stop(self.tint, stop),
            )
            .color_space(gpui::ColorSpace::Srgb);
            let mut clip = inner;
            clip.size.height = half;
            if !top {
                clip.origin.y += half;
            }
            window.with_content_mask(
                Some(ContentMask {
                    bounds: clip,
                    fade_out: Edges::default(),
                }),
                |window| {
                    window.paint_quad(
                        gpui::PaintQuad::new(inner)
                            .background(gradient)
                            .corner_radii(radii),
                    );
                },
            );
        }
    }
}

impl RenderOnce for TintedGlass {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let radius = ds.len(match self.radius {
            GlassRadius::Control => Length::RadiusControl,
            GlassRadius::Panel => Length::RadiusPanel,
            GlassRadius::Popover => Length::RadiusPopover,
            GlassRadius::Composer => Length::AdaptiveComposerRadius,
        });
        let padding = match self.padding {
            GlassPadding::None => px(0.),
            GlassPadding::Sm => ds.len(Length::Space2),
            GlassPadding::Md => ds.len(Length::Space3),
            GlassPadding::Lg => ds.len(Length::Space4),
        };
        let paint = Paint::new(ds, radius, self.square_top);
        let layer = canvas(
            |_, _, _| (),
            move |bounds, (), window, _| paint.paint(bounds, window),
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();
        // The paint layer sits outside the clipping box: the drop shadow falls beyond the surface.
        let (square_top, height) = (self.square_top, self.height);
        let round = move |el: gpui::Div| {
            if square_top {
                el.rounded_b(radius)
            } else {
                el.rounded(radius)
            }
        };
        let fill = move |el: gpui::Div| if height.is_some() { el.h_full() } else { el };
        let outer = round(div().relative().min_w_0());
        let outer = match height {
            Some(height) => outer.h(height),
            None => outer,
        };
        strut::scope(
            true,
            outer
                .text_color(ds.color(Color::TextPrimary))
                .child(layer)
                // The 1px border of the surface stays in layout, so the content keeps the DS geometry.
                .child(
                    fill(round(div().min_w_0().overflow_hidden())).child(
                        fill(strut::container(div(), ds))
                            .p(padding + px(1.)) // DS: TintedGlass.module.css:5
                            .children(self.children),
                    ),
                ),
        )
    }
}
