use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader};

use super::contracts::{
    ImageSanitizerInput, ImageSanitizerLimits, SanitizedImage, VisualAttachmentManifest,
};
use super::manifest::{assert_magic, create_visual_manifest};
use crate::context::{ContextError, ContextResult};

const MAX_SOURCE_BYTES: usize = 10 * 1024 * 1024;
const MAX_WIDTH: u32 = 16_384;
const MAX_HEIGHT: u32 = 16_384;
const MAX_PIXELS: u64 = 64_000_000;

/// Decode, orient, and re-encode from borrowed source bytes. The App owner
/// runs this synchronous work on its single tracked blocking lane.
pub(crate) fn sanitize_image(input: ImageSanitizerInput<'_>) -> ContextResult<SanitizedImage> {
    if input.source_bytes.is_empty() {
        return Err(ContextError::new("image_manifest_invalid", "empty_source"));
    }
    let caller_max_bytes = input.limits.max_bytes.unwrap_or(MAX_SOURCE_BYTES as f64);
    let max_bytes = if caller_max_bytes.is_nan() {
        f64::NAN
    } else {
        caller_max_bytes.min(MAX_SOURCE_BYTES as f64)
    };
    if input.source_bytes.len() as f64 > max_bytes {
        return Err(limit_error());
    }
    let sniffed = assert_magic(input.mime_type, input.source_bytes)?;
    let format = match sniffed.magic {
        "png" => ImageFormat::Png,
        "jpeg" => ImageFormat::Jpeg,
        "gif" => ImageFormat::Gif,
        "webp" => ImageFormat::WebP,
        _ => unreachable!("sniff_image returns only admitted formats"),
    };
    let mut decoder = ImageReader::with_format(Cursor::new(input.source_bytes), format)
        .into_decoder()
        .map_err(preprocess_error)?;
    let (raw_width, raw_height) = decoder.dimensions();
    assert_raw_limits(raw_width, raw_height, input.limits)?;
    let orientation = decoder.orientation().map_err(preprocess_error)?;
    let mut decoded = DynamicImage::from_decoder(decoder).map_err(preprocess_error)?;
    decoded.apply_orientation(orientation);
    let width = decoded.width();
    let height = decoded.height();
    let (derivative_bytes, derivative_mime_type) = encode_derivative(decoded, sniffed.magic)?;
    let manifest = create_visual_manifest(
        &input,
        &derivative_bytes,
        derivative_mime_type,
        width,
        height,
    )?;
    assert_derivative_limits(&manifest, input.limits)?;
    Ok(SanitizedImage {
        manifest,
        bytes: derivative_bytes,
    })
}

fn assert_raw_limits(width: u32, height: u32, limits: ImageSanitizerLimits) -> ContextResult<()> {
    let pixel_count = u64::from(width) * u64::from(height);
    if width == 0
        || height == 0
        || width > MAX_WIDTH
        || height > MAX_HEIGHT
        || pixel_count > MAX_PIXELS
        || f64::from(width) > limits.max_width.unwrap_or(f64::from(MAX_WIDTH))
        || f64::from(height) > limits.max_height.unwrap_or(f64::from(MAX_HEIGHT))
        || pixel_count as f64 > limits.max_pixels.unwrap_or(MAX_PIXELS as f64)
    {
        return Err(limit_error());
    }
    Ok(())
}

fn assert_derivative_limits(
    manifest: &VisualAttachmentManifest,
    limits: ImageSanitizerLimits,
) -> ContextResult<()> {
    if limits
        .max_bytes
        .is_some_and(|max| manifest.source_size_bytes as f64 > max)
        || limits
            .max_width
            .is_some_and(|max| f64::from(manifest.width) > max)
        || limits
            .max_height
            .is_some_and(|max| f64::from(manifest.height) > max)
        || limits
            .max_pixels
            .is_some_and(|max| manifest.pixel_count as f64 > max)
    {
        return Err(limit_error());
    }
    Ok(())
}

fn encode_derivative(image: DynamicImage, magic: &str) -> ContextResult<(Vec<u8>, &'static str)> {
    let mut bytes = Vec::new();
    match magic {
        "jpeg" => {
            JpegEncoder::new_with_quality(&mut bytes, 90)
                .encode_image(&image)
                .map_err(preprocess_error)?;
            Ok((bytes, "image/jpeg"))
        }
        "png" | "gif" => {
            let width = image.width();
            let height = image.height();
            let pixels = image.into_rgba8();
            PngEncoder::new_with_quality(&mut bytes, CompressionType::Best, FilterType::Adaptive)
                .write_image(
                    pixels.as_raw(),
                    width,
                    height,
                    image::ColorType::Rgba8.into(),
                )
                .map_err(preprocess_error)?;
            Ok((bytes, "image/png"))
        }
        "webp" => {
            let width = image.width();
            let height = image.height();
            let pixels = image.into_rgba8();
            let encoded = webp::Encoder::from_rgba(pixels.as_raw(), width, height)
                .encode_simple(false, 90.0)
                .map_err(|error| preprocess_error(format!("{error:?}")))?;
            Ok((encoded.to_vec(), "image/webp"))
        }
        _ => unreachable!("sniff_image returns only admitted formats"),
    }
}

fn limit_error() -> ContextError {
    ContextError::new("image_payload_invalid", "image_limit_exceeded")
}

fn preprocess_error(error: impl std::fmt::Display) -> ContextError {
    ContextError::new(
        "image_payload_invalid",
        format!("preprocess_failed:{error}"),
    )
}
