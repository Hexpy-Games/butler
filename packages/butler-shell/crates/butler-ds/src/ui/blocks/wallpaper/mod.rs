//! DS Wallpaper (blocks/Wallpaper `still.ts`, `stillContext.ts`, `imageCache.ts`, `imageMath.ts`,
//! the engine's host side and WallpaperPicker `builtinPosters.ts`): a live module the renderer
//! has shaders for drawn at its default params, unknown live
//! modules from their bundled posters, or an image. Animated modules hold their still frame
//! (`stillTime`) for now; edited params, drift and crossfade are P6.
//! [`Wallpaper`] is the layer to hand to `WallpaperStage::wallpaper`; it fills its parent, which
//! clips it.
mod image_cache;
mod image_math;
mod live;
mod live_image;
mod live_modules;
mod live_params;
mod live_print;
mod posters;
mod still;

use std::sync::Arc;

use gpui::{
    AnyElement, App, Div, Image, ImageSource, IntoElement, ObjectFit, ParentElement as _,
    RenderOnce, SharedString, Styled as _, StyledImage as _, Window, div, hsla, img,
};

pub use image_cache::{ImageCache, ImageLoader, bundled_image, default_image_asset};
pub use image_math::{
    DARK_DIM_STEP, DIM_SKIP, ImageDim, THUMBNAIL_EDGE, brightness, default_dim, unit, variant_for,
};
pub use posters::{POSTER_SIZE, builtin_poster, poster_modules};
pub use still::{StillCache, StillSize, still_key};

use self::live::{LiveFrame, STILL_DAY_PHASE};
use crate::tokens::Color;
use crate::ui::blocks::prompt_suggestion_list::ContentRect;
use crate::ui::context::Ds;

/// The first-run intro's dried end frame. // DS: intro/introFrame.ts
pub fn intro_print(tone: WallpaperTone, card: Option<ContentRect>) -> AnyElement {
    live::intro_layer(tone, card)
}

/// The theme a wallpaper draws for (`WallpaperTone`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WallpaperTone {
    Light,
    Dark,
}

impl WallpaperTone {
    pub fn from_dark(dark: bool) -> Self {
        if dark { Self::Dark } else { Self::Light }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
}

/// `cover` fills the canvas and crops; `contain` shows the whole image on a neutral field.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ImageFit {
    #[default]
    Cover,
    Contain,
}

/// `thumbnail`: the small preview (long edge 480px); `full`: the stored image.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ImageVariant {
    Full,
    Thumbnail,
}

/// What a wallpaper shows (`WallpaperSource`, without module params and filters: those need the
/// engine).
#[derive(Clone, Debug, PartialEq)]
pub enum WallpaperSource {
    None,
    Live {
        module: SharedString,
    },
    Image {
        asset: SharedString,
        fit: ImageFit,
        /// 0..1 darkening (the dark theme adds one step).
        dim: f32,
        /// 0..1 blur relative to the canvas size.
        blur: f32,
    },
}

/// Content key of a source: equal sources share a key. // DS: keys.ts:35-37
pub fn source_key(source: &WallpaperSource) -> String {
    match source {
        WallpaperSource::None => "none".into(),
        WallpaperSource::Live { module } => format!("live:{module}"),
        WallpaperSource::Image {
            asset,
            fit,
            dim,
            blur,
        } => format!("image:{asset}:{fit:?}:{dim}:{blur}"),
    }
}

/// Transition key of a source: changing it crossfades; params, fit, dim, blur and tone redraw in
/// place. // DS: keys.ts:44-48
pub fn transition_key(source: &WallpaperSource) -> String {
    match source {
        WallpaperSource::None => "none".into(),
        WallpaperSource::Live { module } => format!("live:{module}"),
        WallpaperSource::Image { asset, .. } => format!("image:{asset}"),
    }
}

/// The wallpaper layer: the module's frame (or its poster) for a live module, the picture for an
/// image source, nothing for `none`.
#[derive(IntoElement)]
pub struct Wallpaper {
    source: WallpaperSource,
    tone: Option<WallpaperTone>,
    picture: Option<Arc<Image>>,
    content_rect: Option<ContentRect>,
    content_rect2: Option<ContentRect>,
    day_phase: f32,
}

impl Wallpaper {
    pub fn new(source: WallpaperSource) -> Self {
        Self {
            source,
            tone: None,
            picture: None,
            content_rect: None,
            content_rect2: None,
            day_phase: STILL_DAY_PHASE,
        }
    }

    /// The content a live module composes around (`contentRect`), in window px; none by default.
    pub fn content_rect(mut self, rect: Option<ContentRect>) -> Self {
        self.content_rect = rect;
        self
    }

    /// The composer a live module keeps clear of (`contentRect2`), in window px; none by default.
    pub fn content_rect2(mut self, rect: Option<ContentRect>) -> Self {
        self.content_rect2 = rect;
        self
    }

    /// Local time of day, 0..1 from midnight (`u_dayPhase`); a still's midday by default.
    pub fn day_phase(mut self, phase: f32) -> Self {
        self.day_phase = phase;
        self
    }

    /// Draws for this tone; the DS theme's by default.
    pub fn tone(mut self, tone: WallpaperTone) -> Self {
        self.tone = Some(tone);
        self
    }

    /// The decoded picture of an image source (from [`ImageCache::image`]).
    pub fn picture(mut self, picture: Arc<Image>) -> Self {
        self.picture = Some(picture);
        self
    }
}

impl RenderOnce for Wallpaper {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let tone = self.tone.unwrap_or(WallpaperTone::from_dark(ds.dark()));
        let layer = div().relative().size_full().overflow_hidden();
        match self.source {
            WallpaperSource::None => layer,
            WallpaperSource::Live { module } => {
                let frame = LiveFrame {
                    tone,
                    day_phase: self.day_phase,
                    content_rect: self.content_rect,
                    content_rect2: self.content_rect2,
                };
                match live::layer(&module, frame, cx) {
                    Some((drawn, remaining)) => dim_pass(layer.child(drawn), remaining),
                    None => match builtin_poster(&module, tone) {
                        Some(poster) => layer.child(picture(poster, ObjectFit::Cover)),
                        None => layer,
                    },
                }
            }
            WallpaperSource::Image { fit, dim, .. } => {
                let Some(image) = self.picture else {
                    return layer;
                };
                let object_fit = match fit {
                    ImageFit::Cover => ObjectFit::Cover,
                    ImageFit::Contain => ObjectFit::Contain,
                };
                let remaining = brightness(dim, tone == WallpaperTone::Dark, ImageDim::Auto);
                let field = (fit == ImageFit::Contain).then(|| ds.color(Color::Surface));
                let layer = match field {
                    Some(field) => layer.bg(field),
                    None => layer,
                };
                dim_pass(layer.child(picture(image, object_fit)), remaining)
            }
        }
    }
}

fn picture(image: Arc<Image>, fit: ObjectFit) -> impl IntoElement {
    img(ImageSource::Image(image)).size_full().object_fit(fit)
}

/// The dim pass: black over the picture with the alpha the brightness leaves.
fn dim_pass(layer: Div, brightness: f32) -> Div {
    if brightness >= 1. {
        return layer;
    }
    layer.child(
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .bg(hsla(0., 0., 0., 1. - brightness)),
    )
}
