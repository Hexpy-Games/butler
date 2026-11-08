//! DS TintedGlass (TintedGlass.tsx): the surface every overlay uses. Its API and layout are the
//! DS's, but it renders Liquid Glass (owner decision): the fitted native lens, with its own
//! shadow, rim and hairline, instead of `saturate() blur(4px)` under an opaque tint. The children
//! paint after the glass and stay sharp.
use gpui::{
    AnyElement, App, Bounds, Corners, IntoElement, ParentElement, Pixels, RenderOnce, Styled as _,
    Window, canvas, div, px,
};

use super::context::Ds;
use super::liquid_glass::{self, LiquidGlass, Presence};
use super::motion::{Props, Transition};
use super::strut;
use crate::tokens::{Color, Length};

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
    /// The bottom corners are square (a sheet on the bottom edge).
    square_bottom: bool,
    dark: bool,
    glass: LiquidGlass,
}

#[derive(IntoElement)]
pub struct TintedGlass {
    radius: GlassRadius,
    padding: GlassPadding,
    square_top: bool,
    square_bottom: bool,
    column: Option<Pixels>,
    height: Option<Pixels>,
    presence: Option<Presence>,
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
            presence: None,
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

    /// How present the surface is, 0..=1 (an enter or exit animation's progress): the glass
    /// materializes with it instead of fading (LG research §5 Appear/disappear, §8.1.6) while the
    /// content fades. Without it the glass takes the presence of the enclosing overlay
    /// ([`liquid_glass::presence`]), if any. The caller must not fade the glass's ancestors.
    pub fn presence(mut self, progress: f32) -> Self {
        self.presence = Some(Presence::Static(progress.clamp(0., 1.)));
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

impl Paint {
    fn new(ds: &Ds, radius: Pixels, square: (bool, bool), presence: Presence) -> (Self, gpui::Div) {
        let mut glass = LiquidGlass::over_content().adapt(ds);
        glass.materialize = presence;
        let content = match presence {
            Presence::Static(t) => div().min_w_0().overflow_hidden().opacity(t),
            Presence::Moving {
                from,
                to,
                start_ms,
                timing,
            } => Transition {
                from: 0.,
                to: 1.,
                start_ms,
            }
            .apply(
                div().min_w_0().overflow_hidden(),
                &timing,
                &Props {
                    opacity: Some((from, to)),
                    ..Default::default()
                },
            ),
        };
        let paint = Self {
            radius,
            square_top: square.0,
            square_bottom: square.1,
            dark: ds.dark(),
            glass,
        };
        (paint, content)
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
        liquid_glass::paint(bounds, radii, self.dark, self.glass, window);
    }
}

impl RenderOnce for TintedGlass {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let presence = self
            .presence
            .or_else(|| liquid_glass::presence(cx))
            .unwrap_or(Presence::Static(1.));
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
        let (paint, content) =
            Paint::new(ds, radius, (self.square_top, self.square_bottom), presence);
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
                    shrink(fill(round(content))).child(
                        shrink(fill(strut::container(div(), ds)))
                            .px(padding + px(1.)) // DS: TintedGlass.module.css:5
                            .pt(padding + px(1.))
                            .pb(padding + bottom_border)
                            .children(
                                self.children
                                    .into_iter()
                                    .map(liquid_glass::without_presence),
                            ),
                    ),
                ),
        )
    }
}
