//! The card's glass: TintedGlass (`TintedGlass.module.css`) with the variables
//! `.itemFrame` sets (`PromptSuggestionList.module.css:171-207`): a lighter base and tint, the
//! border mixed from the composer glass border and the line, `saturate(1.24)`, no drop shadow.
//! The hover and focus state brightens the base and the border. TintedGlass takes no such
//! overrides, so the layers are painted here, in the same order.
use gpui::{
    AnyElement, App, Bounds, ContentMask, Corners, Edges, Hsla, IntoElement as _, Pixels,
    Styled as _, Window, canvas, linear_color_stop, linear_gradient, point, px, size,
};

use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::convert;

/// `--tinted-glass-filter: saturate(1.24) blur(...)`.
const SATURATION: f32 = 1.24; // DS: PromptSuggestionList.module.css:203
/// The shares of `--surface-raised` (base, tint) and of the glass border (against the line) at
/// rest and brightened.
const BASE: (f32, f32) = (0.58, 0.68); // DS: PromptSuggestionList.module.css:192, :216
const TINT: f32 = 0.48; // DS: PromptSuggestionList.module.css:198
const BORDER: (f32, f32) = (0.72, 0.88); // DS: PromptSuggestionList.module.css:195, :219

#[derive(Clone)]
struct Paint {
    radius: Pixels,
    base: Hsla,
    tint: Hsla,
    border: Hsla,
    edge: Pixels,
    blur: Pixels,
    highlight: gpui::BoxShadow,
}

/// The glass layer, filling its parent. `bright` is hover or keyboard focus (the base); `tone`
/// (0 at rest, 1 brightened) eases the border over `--motion-base`.
pub(super) fn layer(ds: &Ds, bright: bool, tone: f32) -> AnyElement {
    let raised = ds.color(Color::SurfaceRaised);
    let glass = ds.color(Color::ComposerGlassBorder);
    let line = ds.color(Color::Line);
    let base = if bright { BASE.1 } else { BASE.0 };
    let paint = Paint {
        radius: ds.len(Length::RadiusPanel),
        base: convert::with_alpha(raised, base),
        tint: convert::with_alpha(raised, TINT),
        border: convert::mix(
            convert::mix(glass, line, BORDER.1),
            convert::mix(glass, line, BORDER.0),
            tone,
        ),
        edge: ds.len(Length::TintedGlassEdgeSize),
        blur: ds.len(Length::TintedGlassBlur),
        highlight: gpui::BoxShadow {
            color: ds.color(Color::TintedGlassHighlight).into(),
            offset: point(px(0.), px(1.)), // DS: TintedGlass.module.css:23
            blur_radius: px(0.),
            spread_radius: px(0.),
            inset: true,
        },
    };
    canvas(
        |_, _, _| (),
        move |bounds, (), window, _: &mut App| paint.paint(bounds, window),
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
    .into_any_element()
}

impl Paint {
    fn paint(&self, bounds: Bounds<Pixels>, window: &mut Window) {
        let radius = self
            .radius
            .min(bounds.size.width / 2.)
            .min(bounds.size.height / 2.);
        let radii = Corners::all(radius);
        let lens = gpui::BackdropLens {
            saturation: Some(SATURATION),
            ..gpui::BackdropLens::default()
        };
        window.paint_backdrop_lens(bounds, radii, 0., &[gpui::Filter::Blur(self.blur)], lens);
        window.paint_quad(
            gpui::PaintQuad::new(bounds)
                .background(self.base)
                .corner_radii(radii),
        );
        self.paint_tint(bounds, radius, window);
        window.paint_inset_shadows(bounds, radii, 0., std::slice::from_ref(&self.highlight));
        window.paint_quad(
            gpui::PaintQuad::new(bounds)
                .corner_radii(radii)
                .border_widths(Edges::all(px(1.))) // DS: TintedGlass.module.css:5
                .border_color(self.border),
        );
    }

    /// The tint layers in the padding box: a fade from clear to the tint over the edge size at
    /// the top and at the bottom, the opaque tint between. Two full-height gradients, each
    /// clipped to its half, give all three.
    fn paint_tint(&self, bounds: Bounds<Pixels>, radius: Pixels, window: &mut Window) {
        let border = px(1.); // DS: TintedGlass.module.css:5
        let inner = Bounds::new(
            bounds.origin + point(border, border),
            bounds.size - size(border * 2., border * 2.),
        );
        let radii = Corners::all((radius - border).max(px(0.)));
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
