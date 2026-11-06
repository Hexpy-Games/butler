//! DS TintedGlass (TintedGlass.tsx / TintedGlass.module.css): the surface every overlay uses.
//! A translucent base with an opaque tint in the middle and 20px edge fades, a hairline border,
//! the soft shadow with an inset top highlight, over `saturate() blur(4px)` of what is behind.
use gpui::{
    AnyElement, App, Bounds, ContentMask, Corners, Edges, Hsla, IntoElement, ParentElement, Pixels,
    RenderOnce, Styled as _, Window, canvas, div, linear_color_stop, linear_gradient, px,
};

use super::backdrop::Backdrop;
use super::context::Ds;
use super::convert;
use super::strut;
use crate::tokens::{Color, Filter, Length, Shadow};

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
    /// The bottom corners are square and the bottom border is gone (a sheet on the bottom edge).
    square_bottom: bool,
    border: Hsla,
    base: Hsla,
    tint: Hsla,
    edge: Pixels,
    shadow: Vec<gpui::BoxShadow>,
    highlight: gpui::BoxShadow,
    backdrop: Backdrop,
}

#[derive(IntoElement)]
pub struct TintedGlass {
    radius: GlassRadius,
    padding: GlassPadding,
    square_top: bool,
    square_bottom: bool,
    column: Option<Pixels>,
    height: Option<Pixels>,
    children: Vec<AnyElement>,
}

impl TintedGlass {
    pub fn new() -> Self {
        Self {
            radius: GlassRadius::Panel,
            padding: GlassPadding::Md,
            square_top: false,
            square_bottom: false,
            column: None,
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

    /// Only the top corners are rounded and the bottom border is gone
    /// (`border-end-end-radius: 0; border-end-start-radius: 0; border-bottom: 0`).
    pub fn square_bottom(mut self) -> Self {
        self.square_bottom = true;
        self
    }

    /// The content is a flex column that is no taller than `max_height`: its last child may
    /// shrink and scroll (a sheet's body).
    pub fn column(mut self, max_height: Pixels) -> Self {
        self.column = Some(max_height);
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
    fn new(ds: &Ds, radius: Pixels, square: (bool, bool)) -> Self {
        Self {
            radius,
            square_top: square.0,
            square_bottom: square.1,
            border: ds.color(Color::TintedGlassBorder),
            base: ds.color(Color::TintedGlassBg),
            tint: ds.color(Color::TintedGlassTint),
            edge: ds.len(Length::TintedGlassEdgeSize),
            shadow: convert::box_shadows(
                ds.tokens().shadow(Shadow::TintedGlassShadow),
                ds.tokens(),
            ),
            highlight: highlight(ds),
            // DS: TintedGlass.module.css:23 `backdrop-filter: var(--tinted-glass-filter)`.
            backdrop: Backdrop::new(ds, Filter::TintedGlassFilter),
        }
    }

    /// The border widths: 1px, without the bottom one on a bottom sheet.
    fn borders(&self) -> Edges<Pixels> {
        Edges {
            bottom: if self.square_bottom { px(0.) } else { px(1.) },
            ..Edges::all(px(1.))
        }
    }

    fn corners(&self, radius: Pixels) -> Corners<Pixels> {
        let top = if self.square_top { px(0.) } else { radius };
        let bottom = if self.square_bottom { px(0.) } else { radius };
        Corners {
            top_left: top,
            top_right: top,
            bottom_left: bottom,
            bottom_right: bottom,
        }
    }

    fn paint(&self, bounds: Bounds<Pixels>, window: &mut Window) {
        let r = self
            .radius
            .min(bounds.size.width / 2.)
            .min(bounds.size.height / 2.);
        let radii = self.corners(r);
        window.paint_drop_shadows_outside(bounds, radii, 0., &self.shadow);
        self.backdrop.paint(bounds, radii, window);
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
                .border_widths(self.borders()) // DS: TintedGlass.module.css:5
                .border_color(self.border),
        );
    }

    /// The tint layers, in the padding box: a fade from clear to the tint over the edge size at
    /// the top, the same at the bottom, and the opaque tint between. Two full-height gradients,
    /// each clipped to its half, give all three.
    fn paint_tint(&self, bounds: Bounds<Pixels>, radius: Pixels, window: &mut Window) {
        let border = px(1.); // DS: TintedGlass.module.css:5
        let bottom = self.borders().bottom;
        let inner = Bounds::new(
            bounds.origin + gpui::point(border, border),
            bounds.size - gpui::size(border * 2., border + bottom),
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
        let paint = Paint::new(ds, radius, (self.square_top, self.square_bottom));
        let layer = canvas(
            |_, _, _| (),
            move |bounds, (), window, _| paint.paint(bounds, window),
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();
        // The paint layer sits outside the clipping box: the drop shadow falls beyond the surface.
        let (square_top, square_bottom, height) =
            (self.square_top, self.square_bottom, self.height);
        let round = move |el: gpui::Div| match (square_top, square_bottom) {
            (true, true) => el,
            (true, false) => el.rounded_b(radius),
            (false, true) => el.rounded_t(radius),
            (false, false) => el.rounded(radius),
        };
        let bottom_border = if square_bottom { px(0.) } else { px(1.) };
        let fill = move |el: gpui::Div| if height.is_some() { el.h_full() } else { el };
        let outer = round(div().relative().min_w_0());
        let outer = match height {
            Some(height) => outer.h(height),
            None => outer,
        };
        // A column: every box down to the content shrinks, so its last child can scroll.
        let (outer, column) = match self.column {
            Some(max) => (outer.flex().flex_col().max_h(max), true),
            None => (outer, false),
        };
        let shrink = move |el: gpui::Div| {
            if column {
                el.flex().flex_col().flex_auto().min_h_0()
            } else {
                el
            }
        };
        strut::scope(
            true,
            outer
                .text_color(ds.color(Color::TextPrimary))
                .child(layer)
                // The 1px border of the surface stays in layout, so the content keeps the DS geometry.
                .child(
                    shrink(fill(round(div().min_w_0().overflow_hidden()))).child(
                        shrink(fill(strut::container(div(), ds)))
                            .px(padding + px(1.)) // DS: TintedGlass.module.css:5
                            .pt(padding + px(1.))
                            .pb(padding + bottom_border)
                            .children(self.children),
                    ),
                ),
        )
    }
}
