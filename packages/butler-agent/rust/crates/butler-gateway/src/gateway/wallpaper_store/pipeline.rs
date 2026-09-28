//! Decode, orient, bound, measure and re-encode one wallpaper image.
//!
//! The type comes from magic bytes only. Re-encoding drops every metadata
//! block (EXIF, XMP, ICC, text chunks) after the EXIF orientation is applied.

use std::io::Cursor;

use butler_core::json::saturating_u32;
use image::buffer::ConvertBuffer;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::imageops;
use image::metadata::Orientation;
use image::{
    DynamicImage, ExtendedColorType, ImageDecoder, ImageEncoder, ImageError, ImageFormat,
    ImageReader, Limits, RgbImage, RgbaImage,
};

use crate::gateway::GatewayApplicationError;

pub(super) const MAX_INPUT_BYTES: usize = 25 * 1024 * 1024;
const MAX_EDGE: u32 = 3840;
const THUMBNAIL_EDGE: u32 = 480;
/// Longest side of a source image, read from its header before decoding.
pub(crate) const MAX_SOURCE_SIDE: u32 = 16_384;
/// Most pixels of a source image, read from its header before decoding.
pub(crate) const MAX_SOURCE_PIXELS: u64 = 40_000_000;
/// Most memory the decoder may allocate for one image (a 40 MP 8-bit RGBA
/// image is 160 MB; 16-bit sources that large are refused).
const MAX_DECODE_ALLOC: u64 = 256 * 1024 * 1024;
const JPEG_QUALITY: u8 = 88;

/// Whether `width` x `height` is within the source caps.
pub(crate) fn within_source_limits(width: u32, height: u32) -> bool {
    width > 0
        && height > 0
        && width <= MAX_SOURCE_SIDE
        && height <= MAX_SOURCE_SIDE
        && u64::from(width) * u64::from(height) <= MAX_SOURCE_PIXELS
}

pub(super) struct EncodedImage {
    pub(super) bytes: Vec<u8>,
    pub(super) mime_type: &'static str,
    pub(super) width: u32,
    pub(super) height: u32,
}

pub(super) struct ProcessedWallpaper {
    pub(super) image: EncodedImage,
    pub(super) thumbnail: EncodedImage,
    pub(super) luminance: f64,
    pub(super) color: String,
}

pub(super) fn process(source: &[u8]) -> Result<ProcessedWallpaper, GatewayApplicationError> {
    if source.len() > MAX_INPUT_BYTES {
        return Err(GatewayApplicationError::public(
            413,
            "wallpaper_too_large",
            "Wallpaper image must be 25 MB or smaller.",
        ));
    }
    if source.is_empty() {
        return Err(unreadable());
    }
    let format = sniff(source).ok_or_else(|| {
        GatewayApplicationError::public(
            415,
            "wallpaper_unsupported_type",
            "Wallpaper image must be a JPEG, PNG or WebP file.",
        )
    })?;
    let decoded = decode(source, format)?;
    let (width, height) = fit(decoded.width(), decoded.height(), MAX_EDGE);
    // Downscaling averages whole-pixel areas in the source's own sample type
    // (no float copy of a large source); only the fitted result becomes RGBA8.
    let pixels = if (width, height) == (decoded.width(), decoded.height()) {
        decoded.into_rgba8()
    } else {
        decoded.thumbnail_exact(width, height).into_rgba8()
    };
    let (thumbnail_width, thumbnail_height) = fit(width, height, THUMBNAIL_EDGE);
    let thumbnail = if (thumbnail_width, thumbnail_height) == (width, height) {
        pixels.clone()
    } else {
        imageops::thumbnail(&pixels, thumbnail_width, thumbnail_height)
    };
    let opaque = pixels.pixels().all(|pixel| pixel[3] == u8::MAX);
    let (luminance, color) = average(&thumbnail);
    Ok(ProcessedWallpaper {
        image: encode(&pixels, opaque)?,
        thumbnail: encode(&thumbnail, opaque)?,
        luminance,
        color,
    })
}

fn sniff(source: &[u8]) -> Option<ImageFormat> {
    if source.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(ImageFormat::Jpeg)
    } else if source.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(ImageFormat::Png)
    } else if source.starts_with(b"RIFF") && source.get(8..12) == Some(b"WEBP".as_slice()) {
        Some(ImageFormat::WebP)
    } else {
        None
    }
}

/// Decodes under explicit limits after checking the header dimensions, then
/// applies EXIF orientation.
fn decode(source: &[u8], format: ImageFormat) -> Result<DynamicImage, GatewayApplicationError> {
    let mut reader = ImageReader::with_format(Cursor::new(source), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SOURCE_SIDE);
    limits.max_image_height = Some(MAX_SOURCE_SIDE);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits);
    let decoder = reader.into_decoder().map_err(decode_error)?;
    let (width, height) = decoder.dimensions();
    if !within_source_limits(width, height) {
        return Err(unsupported_dimensions());
    }
    let mut decoder = decoder;
    // Malformed EXIF must not reject an otherwise readable photo.
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder).map_err(decode_error)?;
    image.apply_orientation(orientation);
    Ok(image)
}

/// A limit the decoder hit is the image's size; anything else is unreadable.
fn decode_error(error: ImageError) -> GatewayApplicationError {
    if matches!(error, ImageError::Limits(_)) {
        unsupported_dimensions().with_source(error)
    } else {
        unreadable().with_source(error)
    }
}

fn unsupported_dimensions() -> GatewayApplicationError {
    GatewayApplicationError::public(
        400,
        "wallpaper_dimensions_unsupported",
        "Wallpaper image dimensions are not supported.",
    )
}

/// The size that fits `edge` on the long side, keeping the aspect ratio.
fn fit(width: u32, height: u32, edge: u32) -> (u32, u32) {
    let long = width.max(height);
    if long <= edge {
        return (width, height);
    }
    let scale = f64::from(edge) / f64::from(long);
    let side = |length: u32| saturating_u32((f64::from(length) * scale).round()).clamp(1, edge);
    (side(width), side(height))
}

/// JPEG for opaque images, PNG when any pixel is transparent.
fn encode(pixels: &RgbaImage, opaque: bool) -> Result<EncodedImage, GatewayApplicationError> {
    let (width, height) = pixels.dimensions();
    let mut bytes = Vec::new();
    let (written, mime_type) = if opaque {
        let rgb: RgbImage = pixels.convert();
        let written = JpegEncoder::new_with_quality(&mut bytes, JPEG_QUALITY).write_image(
            rgb.as_raw(),
            width,
            height,
            ExtendedColorType::Rgb8,
        );
        (written, "image/jpeg")
    } else {
        let written =
            PngEncoder::new_with_quality(&mut bytes, CompressionType::Default, PngFilter::Adaptive)
                .write_image(pixels.as_raw(), width, height, ExtendedColorType::Rgba8);
        (written, "image/png")
    };
    written.map_err(GatewayApplicationError::internal_from)?;
    Ok(EncodedImage {
        bytes,
        mime_type,
        width,
        height,
    })
}

/// Average relative luminance (0..1, 4 decimals) and colour (`#rrggbb`) of the
/// pixels, averaged in linear light and weighted by alpha.
fn average(pixels: &RgbaImage) -> (f64, String) {
    let linear: [f64; 256] =
        std::array::from_fn(|value| srgb_to_linear(value as f64 / f64::from(u8::MAX)));
    let mut sums = [0.0_f64; 3];
    let mut weight = 0.0;
    for pixel in pixels.pixels() {
        let alpha = f64::from(pixel[3]) / f64::from(u8::MAX);
        for (sum, channel) in sums.iter_mut().zip(pixel.0) {
            *sum += linear[usize::from(channel)] * alpha;
        }
        weight += alpha;
    }
    if weight == 0.0 {
        return (0.0, "#000000".to_owned());
    }
    let [red, green, blue] = sums.map(|sum| sum / weight);
    let luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    let color = format!(
        "#{:02x}{:02x}{:02x}",
        linear_to_srgb(red),
        linear_to_srgb(green),
        linear_to_srgb(blue)
    );
    (
        (luminance.clamp(0.0, 1.0) * 10_000.0).round() / 10_000.0,
        color,
    )
}

fn srgb_to_linear(value: f64) -> f64 {
    if value <= 0.040_45 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_to_srgb(value: f64) -> u8 {
    let encoded = if value <= 0.003_130_8 {
        value * 12.92
    } else {
        1.055 * value.powf(1.0 / 2.4) - 0.055
    };
    u8::try_from(saturating_u32(
        (encoded.clamp(0.0, 1.0) * f64::from(u8::MAX)).round(),
    ))
    .unwrap_or(u8::MAX)
}

fn unreadable() -> GatewayApplicationError {
    GatewayApplicationError::public(
        400,
        "wallpaper_image_invalid",
        "Wallpaper image could not be read.",
    )
}
