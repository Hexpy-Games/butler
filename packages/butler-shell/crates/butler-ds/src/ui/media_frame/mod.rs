//! DS MediaFrame (MediaFrame.tsx / MediaFrame.module.css): a picture in a fixed-shape frame on
//! the neutral matte. Every picture is whole by default (`Contain`): a typical shape spans the
//! frame, an extreme one (a wide strip, a tall column) sits inset with a hairline; `Cover` fills
//! the frame from the centre. The picture stays hidden until its shape is known, then fades in
//! over the matte (`--motion-slow`, at once when it was decoded already or under reduced motion).
//! A missing or broken picture is the empty matte, or a tinted placeholder with one centred mark
//! when asked. Pictures are never tinted in dark mode; only the matte follows the theme.
//!
//! Pictures come from gpui's image sources (embedded assets, files or decoded in-memory images);
//! fetching over the network is not part of the frame.
mod load;
mod paint;

use std::time::Instant;

use gpui::{
    AnyElement, App, Bounds, ElementId, ImageSource, IntoElement, ParentElement, Pixels,
    RenderOnce, Styled as _, StyledImage as _, Window, canvas, div, px,
};

pub(crate) use self::load::{Load, resolve};
use self::paint::{Mode, Picture, paint_glow};
use super::Icon;
use super::context::Ds;
use super::convert;
use super::icon::{IconSize, icon};
use crate::tokens::{Color, Duration as DsDuration, Easing, Length, Shadow};

/// Frame shapes, width:height.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Aspect {
    Square,
    FourFive,
    ThreeFour,
    #[default]
    SixteenTen,
    SixteenNine,
}

impl Aspect {
    pub fn ratio(self) -> f32 {
        match self {
            Self::Square => 1.,
            Self::FourFive => 4. / 5.,
            Self::ThreeFour => 3. / 4.,
            Self::SixteenTen => 16. / 10.,
            Self::SixteenNine => 16. / 9.,
        }
    }
}

/// `Contain` keeps every picture whole; `Cover` fills the frame, cropped from the centre.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Fit {
    #[default]
    Contain,
    Cover,
}

/// Width/height band that spans the frame (contained, letterboxed on the matte): a product shot,
/// a square, a page view. Outside it a spanning picture would be a full-width band of page colour
/// flush with the frame's edges, which reads as a spill, so it sits inset.
const FILL_MIN_RATIO: f32 = 0.75; // DS: MediaFrame.tsx:34
const FILL_MAX_RATIO: f32 = 2.4; // DS: MediaFrame.tsx:35

/// What the frame shows, with when it started to (for the fades).
struct State {
    /// A render has seen the picture still loading, so its arrival fades in.
    waited: bool,
    arrived: Option<Instant>,
}

#[derive(IntoElement)]
pub struct MediaFrame {
    id: ElementId,
    src: Option<ImageSource>,
    aspect: Aspect,
    natural: Option<(f32, f32)>,
    fit: Fit,
    placeholder: bool,
    placeholder_icon: Option<ImageSource>,
    clear_top: bool,
    reduced_motion: Option<bool>,
    children: Vec<AnyElement>,
}

impl MediaFrame {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            src: None,
            aspect: Aspect::default(),
            natural: None,
            fit: Fit::Contain,
            placeholder: false,
            placeholder_icon: None,
            clear_top: false,
            reduced_motion: None,
            children: Vec::new(),
        }
    }

    /// The picture; omitted, an empty matte of the same shape.
    pub fn src(mut self, src: impl Into<ImageSource>) -> Self {
        self.src = Some(src.into());
        self
    }

    /// Frame shape. Default 16:10. Ignored with `natural`.
    pub fn aspect(mut self, aspect: Aspect) -> Self {
        self.aspect = aspect;
        self
    }

    /// The picture's own display size in logical px (its pixel size over its pixel ratio): the
    /// frame takes the picture's exact shape and is never wider than this width.
    pub fn natural(mut self, width: f32, height: f32) -> Self {
        self.natural = Some((width, height));
        self
    }

    pub fn fit(mut self, fit: Fit) -> Self {
        self.fit = fit;
        self
    }

    /// A missing or broken picture shows a tinted placeholder with a centred icon.
    pub fn placeholder(mut self) -> Self {
        self.placeholder = true;
        self
    }

    /// The placeholder's icon: a favicon on a light plate. Omitted or broken: an image glyph.
    pub fn placeholder_icon(mut self, icon: impl Into<ImageSource>) -> Self {
        self.placeholder_icon = Some(icon.into());
        self
    }

    /// A matted picture keeps the top clear of an overlay on the frame's top corner (a kind Tag).
    pub fn clear_top(mut self) -> Self {
        self.clear_top = true;
        self
    }

    /// Forces reduced motion (the picture appears without its load fade) on or off; defaults to
    /// the OS and app setting.
    pub fn reduced_motion(mut self, reduced: bool) -> Self {
        self.reduced_motion = Some(reduced);
        self
    }
}

impl ParentElement for MediaFrame {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// `fill` (spans the frame) for typical shapes; `matte` (whole, inset on the matte) for extreme ones.
fn classify(width: f32, height: f32) -> Mode {
    if !(width > 0. && height > 0.) {
        return Mode::Matte;
    }
    let ratio = width / height;
    if (FILL_MIN_RATIO..=FILL_MAX_RATIO).contains(&ratio) {
        Mode::Fill
    } else {
        Mode::Matte
    }
}

/// The placeholder's centred mark: the favicon on a light plate, or the image glyph.
fn placeholder_mark(
    id: &ElementId,
    favicon: Option<&ImageSource>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let working = favicon.and_then(|source| {
        match resolve(&(id.clone(), "favicon").into(), source, window, cx) {
            Load::Ready(data) => Some(data),
            _ => None,
        }
    });
    let ds = Ds::get(cx);
    match working {
        Some(data) => {
            let plate = ds.len(Length::IconSize2xl);
            let side = ds.len(Length::IconSizeLg);
            let ring = gpui::BoxShadow {
                color: ds.color(Color::FaviconPlateLine).into(),
                offset: gpui::point(px(0.), px(0.)),
                blur_radius: px(0.),
                spread_radius: ds.len(Length::BorderHairline),
                inset: false,
            };
            div()
                .flex()
                .items_center()
                .justify_center()
                .size(plate)
                .rounded(ds.len(Length::RadiusControl))
                .bg(ds.color(Color::FaviconPlate))
                .shadow(vec![ring])
                .child(
                    gpui::img(ImageSource::Render(data))
                        .size(side)
                        .object_fit(gpui::ObjectFit::Contain),
                )
                .into_any_element()
        }
        None => div()
            .text_color(ds.color(Color::IconMuted))
            .child(icon(Icon::ImageIcon, IconSize::Xl, ds))
            .into_any_element(),
    }
}

impl RenderOnce for MediaFrame {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let now = cx.background_executor().now();
        let load = match &self.src {
            Some(source) => resolve(&self.id, source, window, cx),
            None => Load::Failed,
        };
        let empty = self.src.is_none();
        let state = window.use_keyed_state((self.id.clone(), "state"), cx, |_, _| State {
            waited: false,
            arrived: None,
        });
        let (reduced, slow, ease) = {
            let ds = Ds::get(cx);
            (
                self.reduced_motion.unwrap_or_else(|| ds.reduced_motion()),
                ds.duration(DsDuration::MotionSlow),
                ds.tokens().ease(Easing::MotionEaseDecelerate),
            )
        };
        let shown = state.update(cx, |state, _| {
            // A picture that arrives after the frame was drawn without it (or still loading)
            // fades in; one that was there from the first draw shows at once.
            if empty || matches!(load, Load::Pending) {
                state.waited = true;
                state.arrived = None;
            } else if state.waited && state.arrived.is_none() {
                state.arrived = Some(now);
            }
            // A picture decoded when the frame first drew shows at once, and so does every one
            // under reduced motion.
            match (state.arrived, reduced) {
                (Some(since), false) => {
                    let t = now.saturating_duration_since(since).as_secs_f32() / slow.as_secs_f32();
                    (convert::ease_at(ease, t.clamp(0., 1.)), t < 1.)
                }
                _ => (1., false),
            }
        });
        if shown.1 {
            window.request_animation_frame();
        }
        let ds = Ds::get(cx);
        let frame_radius = ds.len(Length::RadiusControl);
        let mut frame = div()
            .relative()
            .min_w_0()
            .overflow_hidden()
            .rounded(frame_radius)
            .bg(ds.color(Color::Muted));
        frame = match self.natural {
            Some((width, height)) => frame.w_full().aspect_ratio(width / height),
            None => frame.w_full().aspect_ratio(self.aspect.ratio()),
        };
        let missing = matches!(load, Load::Failed) && self.placeholder;
        let favicon = self.placeholder_icon.take();
        let layers = [
            self.picture(&load, frame_radius, shown.0, cx),
            missing
                .then(|| Self::placeholder_layer(&self.id, favicon.as_ref(), shown.0, window, cx)),
        ];
        let frame = frame
            .children(layers.into_iter().flatten())
            .children(self.children);
        // The wrapper takes the clamped width, so the aspect ratio resolves against it.
        match self.natural {
            Some((width, _)) => div()
                .w_full()
                .max_w(px(width))
                .child(frame)
                .into_any_element(),
            None => frame.into_any_element(),
        }
    }
}

impl MediaFrame {
    /// The picture layer: inset on a matte, whole in the frame or covering it.
    fn picture(&self, load: &Load, radius: Pixels, opacity: f32, cx: &App) -> Option<AnyElement> {
        let Load::Ready(data) = load else {
            return None;
        };
        let ds = Ds::get(cx);
        let pixels = data.size(0);
        let mode = match (self.fit, self.natural) {
            (Fit::Cover, _) => Mode::Cover,
            // A frame in the picture's own shape always spans it.
            (Fit::Contain, Some(_)) => Mode::Fill,
            (Fit::Contain, None) => classify(pixels.width.0 as f32, pixels.height.0 as f32),
        };
        let picture = Picture {
            data: data.clone(),
            mode,
            radius,
            matte_shadows: matte_shadows(ds),
        };
        let mut layer = div().absolute().left_0().right_0().top_0().bottom_0();
        if mode == Mode::Matte {
            let inset = ds.len(Length::SpaceMd);
            let top = if self.clear_top {
                ds.len(Length::TagHeightSm) + ds.len(Length::SpaceSm)
            } else {
                inset
            };
            layer = layer.left(inset).right(inset).top(top).bottom(inset);
        }
        Some(
            div()
                .absolute()
                .size_full()
                .opacity(opacity)
                .child(
                    layer.child(
                        canvas(
                            |bounds, _, _| bounds,
                            move |area, frame: Bounds<Pixels>, window, _| {
                                picture.paint(area, frame, window);
                            },
                        )
                        .size_full(),
                    ),
                )
                .into_any_element(),
        )
    }

    /// The tinted placeholder of a missing or broken picture.
    fn placeholder_layer(
        id: &ElementId,
        favicon: Option<&ImageSource>,
        opacity: f32,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let mark = placeholder_mark(id, favicon, window, cx);
        let tint = convert::with_alpha(Ds::get(cx).color(Color::Accent), 0.10); // DS: MediaFrame.module.css:110
        div()
            .absolute()
            .size_full()
            .opacity(opacity)
            .flex()
            .items_center()
            .justify_center()
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, (), window, _| paint_glow(bounds, tint, window),
                )
                .absolute()
                .size_full(),
            )
            .child(mark)
            .into_any_element()
    }
}

/// The matted picture's hairline ring and `--browser-card-shadow`.
fn matte_shadows(ds: &Ds) -> Vec<gpui::BoxShadow> {
    let ring = gpui::BoxShadow {
        color: ds.color(Color::Line).into(),
        offset: gpui::point(px(0.), px(0.)),
        blur_radius: px(0.),
        spread_radius: ds.len(Length::BorderHairline),
        inset: false,
    };
    let mut layers = vec![ring];
    layers.extend(convert::box_shadows(
        ds.tokens().shadow(Shadow::BrowserCardShadow),
        ds.tokens(),
    ));
    layers
}
