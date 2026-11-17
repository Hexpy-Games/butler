//! DS Wallpaper (blocks/Wallpaper `still.ts`, `stillContext.ts`, `imageCache.ts`, `imageMath.ts`,
//! the engine's host side and WallpaperPicker `builtinPosters.ts`): a live module the renderer
//! has shaders for drawn with its saved params, unknown live
//! modules from their bundled posters, or an image drawn by the renderer's image module (fit,
//! blur, an optional filter module and the dim pass). Drift events and crossfade are P6.
//! [`Wallpaper`] is the layer to hand to `WallpaperStage::wallpaper`; it fills its parent, which
//! clips it.
mod drift;
mod image_cache;
mod image_math;
mod live;
mod live_image;
mod live_modules;
mod live_params;
mod live_print;
mod posters;
mod still;
mod watchdog;

use std::sync::Arc;

use gpui::{
    AnyElement, App, Div, Image, ImageSource, IntoElement, ObjectFit, ParentElement as _,
    RenderOnce, SharedString, Styled as _, StyledImage as _, Window, div, hsla, img,
};

pub use gpui::WallpaperImage;
pub use image_cache::{ImageCache, ImageLoader, bundled_image, default_image_asset};
pub use image_math::{
    DARK_DIM_STEP, DIM_SKIP, ImageDim, THUMBNAIL_EDGE, brightness, default_dim, unit, variant_for,
};
pub use live_image::decode_picture;
pub use posters::{POSTER_SIZE, builtin_poster, poster_modules};
pub use still::{StillCache, StillSize, still_key};

use self::live::{LiveFrame, STILL_DAY_PHASE};
use crate::tokens::Color;
use crate::ui::blocks::prompt_suggestion_list::ContentRect;
use crate::ui::context::Ds;
use crate::ui::convert;

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

/// A live source's edited values (`params`, `paramsDark`); `Null` where none are stored.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct WallpaperParams {
    pub params: serde_json::Value,
    pub params_dark: serde_json::Value,
}

/// The `filter` of an image source: a module that takes an image, drawn over the fitted picture.
#[derive(Clone, Debug, PartialEq)]
pub struct ImageFilter {
    pub module: SharedString,
    pub values: WallpaperParams,
}

/// What a wallpaper shows (`WallpaperSource`).
#[derive(Clone, Debug, PartialEq)]
pub enum WallpaperSource {
    None,
    Live {
        module: SharedString,
        values: WallpaperParams,
    },
    Image {
        asset: SharedString,
        fit: ImageFit,
        /// 0..1 darkening (the dark theme adds one step).
        dim: f32,
        /// 0..1 blur relative to the canvas size.
        blur: f32,
        filter: Option<ImageFilter>,
    },
}

impl WallpaperSource {
    /// A live module at its default params.
    pub fn live(module: impl Into<SharedString>) -> Self {
        Self::Live {
            module: module.into(),
            values: WallpaperParams::default(),
        }
    }
}

/// Content key of a source: equal sources share a key. // DS: keys.ts:35-37
pub fn source_key(source: &WallpaperSource) -> String {
    match source {
        WallpaperSource::None => "none".into(),
        WallpaperSource::Live { module, values } => {
            format!("live:{module}:{}:{}", values.params, values.params_dark)
        }
        WallpaperSource::Image {
            asset,
            fit,
            dim,
            blur,
            filter,
        } => {
            let key = format!("image:{asset}:{fit:?}:{dim}:{blur}");
            match filter {
                Some(filter) => format!(
                    "{key}:{}:{}:{}",
                    filter.module, filter.values.params, filter.values.params_dark
                ),
                None => key,
            }
        }
    }
}

/// Transition key of a source: changing it crossfades; params, fit, dim, blur and tone redraw in
/// place. // DS: keys.ts:44-48
pub fn transition_key(source: &WallpaperSource) -> String {
    match source {
        WallpaperSource::None => "none".into(),
        WallpaperSource::Live { module, .. } => format!("live:{module}"),
        WallpaperSource::Image { asset, filter, .. } => format!(
            "image:{asset}:{}",
            filter.as_ref().map_or("", |filter| filter.module.as_ref())
        ),
    }
}

/// What the host tells a drifting print (DS `signals.ts`): battery power, thermal constraint,
/// and the window blur level 0/1/2 (focused, unfocused at least 2 min, at least 10 min).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WallpaperHost {
    pub on_battery: bool,
    pub constrained: bool,
    pub blur: u8,
}

pub fn drifts(source: &WallpaperSource) -> bool {
    match source {
        WallpaperSource::Live { module, .. } => {
            live_modules::get(module).is_some_and(|module| module.manifest["motion"] == "drift")
        }
        _ => false,
    }
}

/// The wallpaper layer: the module's frame (or its poster) for a live module, the picture for an
/// image source, nothing for `none`.
#[derive(IntoElement)]
pub struct Wallpaper {
    source: WallpaperSource,
    tone: Option<WallpaperTone>,
    picture: Option<WallpaperImage>,
    content_rect: Option<ContentRect>,
    content_rect2: Option<ContentRect>,
    column: Option<[f32; 3]>,
    day_phase: f32,
    paused: bool,
    host: WallpaperHost,
    paper: f32,
}

impl Wallpaper {
    pub fn new(source: WallpaperSource) -> Self {
        Self {
            source,
            tone: None,
            picture: None,
            content_rect: None,
            content_rect2: None,
            column: None,
            day_phase: STILL_DAY_PHASE,
            paused: false,
            host: WallpaperHost::default(),
            paper: 0.,
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

    /// `u_col`: the reading column a print keeps its ink out of — its left and right edges and its
    /// top, in px from this wallpaper's own top-left corner (Electron `columnRect`, already made
    /// canvas-relative as engineDrift.ts does); none by default (new chat).
    pub fn column(mut self, left: f32, right: f32, top: f32) -> Self {
        self.column = Some([left, right, top]);
        self
    }

    /// Local time of day, 0..1 from midnight (`u_dayPhase`); a still's midday by default.
    pub fn day_phase(mut self, phase: f32) -> Self {
        self.day_phase = phase;
        self
    }

    /// Holds a still frame when the wallpaper motion setting is paused.
    pub fn motion(mut self, paused: bool) -> Self {
        self.paused = paused;
        self
    }

    pub fn host(mut self, host: WallpaperHost) -> Self {
        self.host = host;
        self
    }

    /// `paperOverlay`: one uniform layer of the theme's paper over the whole wallpaper, 0..0.95;
    /// none by default.
    pub fn paper_overlay(mut self, amount: f32) -> Self {
        self.paper = amount;
        self
    }

    /// Draws for this tone; the DS theme's by default.
    pub fn tone(mut self, tone: WallpaperTone) -> Self {
        self.tone = Some(tone);
        self
    }

    /// The decoded picture of an image source (from [`decode_picture`]).
    pub fn picture(mut self, picture: WallpaperImage) -> Self {
        self.picture = Some(picture);
        self
    }

    fn live_frame(&self, tone: WallpaperTone, window: &Window, cx: &App) -> LiveFrame {
        // DS scheduler.ts `softwareRendering`: a software renderer holds still frames.
        let software = window
            .gpu_specs()
            .is_some_and(|specs| specs.is_software_emulated);
        LiveFrame {
            tone,
            host: self.host,
            animate: !self.paused && !Ds::get(cx).reduced_motion() && !software,
            start_ms: 0,
            day_phase: self.day_phase,
            content_rect: self.content_rect,
            content_rect2: self.content_rect2,
            column: self.column,
        }
    }
}

impl RenderOnce for Wallpaper {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let tone = self.tone.unwrap_or(WallpaperTone::from_dark(ds.dark()));
        let layer = div().relative().size_full().overflow_hidden();
        let frame = self.live_frame(tone, window, cx);
        let paper = self.paper.clamp(0., 0.95);
        let paper_fill = convert::with_alpha(
            ds.color(match tone {
                WallpaperTone::Light => Color::RisoPaperDay,
                WallpaperTone::Dark => Color::RisoPaperNight,
            }),
            paper,
        );
        let layer = match self.source {
            WallpaperSource::None => layer,
            WallpaperSource::Live { module, values } => {
                match live::layer(&module, &values, frame, window, cx) {
                    Some((drawn, remaining)) => dim_pass(layer.child(drawn), remaining),
                    None => match builtin_poster(&module, tone) {
                        Some(poster) => layer.child(picture(poster, ObjectFit::Cover)),
                        None => layer,
                    },
                }
            }
            WallpaperSource::Image {
                fit,
                dim,
                blur,
                filter,
                ..
            } => match self.picture {
                None => layer,
                Some(image) => {
                    let (drawn, remaining) = live::image_layer(
                        image,
                        fit,
                        blur,
                        dim,
                        filter.as_ref(),
                        frame,
                        window,
                        cx,
                    );
                    dim_pass(layer.child(drawn), remaining)
                }
            },
        };
        if paper > 0. {
            layer.child(div().absolute().top_0().left_0().size_full().bg(paper_fill))
        } else {
            layer
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
