//! CPU-only mask operations; callers run decoding, composition and encoding off Tokio.
use butler_models::models::NormalizedRect;
use image::{DynamicImage, ImageBuffer, Luma, RgbaImage, imageops};

pub fn mask_bounds(mask: &RgbaImage) -> Option<NormalizedRect> {
    let (width, height) = mask.dimensions();
    let (mut x0, mut y0, mut x1, mut y1) = (width, height, 0, 0);
    for (x, y, _) in mask.enumerate_pixels().filter(|(_, _, p)| p[3] < 255) {
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x + 1);
        y1 = y1.max(y + 1);
    }
    (x1 > x0 && y1 > y0).then(|| NormalizedRect {
        x0: x0 as f32 / width as f32,
        y0: y0 as f32 / height as f32,
        x1: x1 as f32 / width as f32,
        y1: y1 as f32 / height as f32,
    })
}
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "rounded convex combinations of u8 channels are within 0..=255"
)]
/// Keeps `source` outside the mask's edit region (alpha < 255), feathering
/// inward only; `None` when the mask and the source differ in size.
pub fn composite(source: RgbaImage, generated: DynamicImage, mask: RgbaImage) -> Option<RgbaImage> {
    let (width, height) = source.dimensions();
    if mask.dimensions() != (width, height) {
        return None;
    }
    let generated = if generated.width() != width || generated.height() != height {
        generated.resize_exact(width, height, imageops::FilterType::Lanczos3)
    } else {
        generated
    }
    .to_rgba8();
    let mask = mask.into_raw();
    let weights: ImageBuffer<Luma<f32>, Vec<f32>> = ImageBuffer::from_fn(width, height, |x, y| {
        Luma([1. - f32::from(mask[(y as usize * width as usize + x as usize) * 4 + 3]) / 255.])
    });
    let sigma = 1.5f32.max(0.004 * width.max(height) as f32);
    let blurred = imageops::blur(&weights, sigma);
    let mut output = source;
    for (x, y, pixel) in output.enumerate_pixels_mut() {
        let original = *pixel;
        let w = weights.get_pixel(x, y)[0]
            .min(blurred.get_pixel(x, y)[0])
            .clamp(0., 1.);
        if w == 0. {
            continue;
        }
        let changed = generated.get_pixel(x, y);
        *pixel = image::Rgba(std::array::from_fn(|c| {
            (f32::from(original[c]) * (1. - w) + f32::from(changed[c]) * w).round() as u8
        }));
    }
    Some(output)
}
