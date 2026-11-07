//! `Wallpaper/imageMath.ts`: the pure math of image wallpapers that does not depend on the GL
//! engine: dim, the dark step, the default dim of a new image and which variant to load.
use super::ImageVariant;

/// Brightness the dark theme takes off on top of `dim`. // DS: imageMath.ts:5
pub const DARK_DIM_STEP: f32 = 0.2;
/// Long edge (px) of an asset's thumbnail. // DS: imageMath.ts:9
pub const THUMBNAIL_EDGE: f32 = 480.;
/// Dims up to this are not drawn. // DS: imageMath.ts:37
pub const DIM_SKIP: f32 = 0.05;

// DS: imageMath.ts:22-31
const DIM_FROM_LUMINANCE: f32 = 0.2;
const DIM_PER_LUMINANCE: f32 = 0.6;
const DIM_DEFAULT_MAX: f32 = 0.4;
const DIM_STEP: f32 = 0.05;
const DIM_UNKNOWN: f32 = 0.2;

/// How the drawing module treats `dim` (`imageDim` in a manifest).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ImageDim {
    /// The dark theme dims one step more.
    #[default]
    Auto,
    /// Just `dim`, in both themes.
    NoDarkStep,
    /// Never dimmed.
    None,
}

/// 0..1; anything else (NaN included) reads as 0. // DS: imageMath.ts:57-59
pub fn unit(value: f32) -> f32 {
    if value > 0. { value.min(1.) } else { 0. }
}

/// Readability default for a new image from its average relative luminance (0 black .. 1 white):
/// `clamp(0.6 * (luminance - 0.2), 0, 0.4)` on the 0.05 grid. // DS: imageMath.ts:46-50
pub fn default_dim(luminance: Option<f32>) -> f32 {
    let Some(luminance) = luminance.filter(|value| !value.is_nan()) else {
        return DIM_UNKNOWN;
    };
    let dim = ((luminance - DIM_FROM_LUMINANCE) * DIM_PER_LUMINANCE).clamp(0., DIM_DEFAULT_MAX);
    // Rounded to two decimals like `Number(x.toFixed(2))`.
    ((dim / DIM_STEP).round() * DIM_STEP * 100.).round() / 100.
}

/// Remaining brightness after `dim` under the drawing module's `imageDim`; a dim of at most
/// [`DIM_SKIP`] draws no dim pass (1). // DS: imageMath.ts:81-86
pub fn brightness(dim: f32, dark: bool, mode: ImageDim) -> f32 {
    if mode == ImageDim::None {
        return 1.;
    }
    let step = if dark && mode == ImageDim::Auto {
        1. - DARK_DIM_STEP
    } else {
        1.
    };
    let brightness = (1. - unit(dim)) * step;
    if brightness >= 1. - DIM_SKIP - 1e-6 {
        1.
    } else {
        brightness
    }
}

/// The variant a drawing buffer needs: the thumbnail when it fits, else the full image.
/// // DS: imageMath.ts:128-130
pub fn variant_for(width: f32, height: f32) -> ImageVariant {
    if width.max(height) <= THUMBNAIL_EDGE {
        ImageVariant::Thumbnail
    } else {
        ImageVariant::Full
    }
}
