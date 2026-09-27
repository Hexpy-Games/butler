use image::codecs::gif::GifEncoder;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{DynamicImage, Frame, ImageEncoder, Rgb, RgbImage, Rgba, RgbaImage};
use sha2::{Digest, Sha256};

use super::{
    ImageSanitizerInput, ImageSanitizerLimits, ImageSourceRecord, sanitize_image,
    verify_visual_manifest_source,
};

const EXIF_ORIENTATION_6: [u8; 26] = [
    b'M', b'M', 0, 42, 0, 0, 0, 8, 0, 1, 1, 18, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0,
];

#[test]
fn sanitizes_real_codecs_and_keeps_legacy_source_record_verifiable() {
    let red = RgbaImage::from_pixel(2, 1, Rgba([255, 0, 0, 255]));

    let mut png = Vec::new();
    let mut png_encoder = PngEncoder::new(&mut png);
    png_encoder
        .set_exif_metadata(EXIF_ORIENTATION_6.to_vec())
        .unwrap();
    png_encoder
        .write_image(red.as_raw(), 2, 1, image::ColorType::Rgba8.into())
        .unwrap();
    assert!(png.windows(4).any(|window| window == b"eXIf"));
    let png_result = sanitize(&png, "image/png");
    assert_eq!(
        (png_result.manifest.width, png_result.manifest.height),
        (1, 2)
    );
    assert!(!png_result.bytes.windows(4).any(|window| window == b"eXIf"));

    let mut jpeg = Vec::new();
    let rgb = RgbImage::from_pixel(2, 1, Rgb([255, 0, 0]));
    JpegEncoder::new_with_quality(&mut jpeg, 90)
        .encode_image(&DynamicImage::ImageRgb8(rgb))
        .unwrap();
    let mut oriented_jpeg = Vec::with_capacity(jpeg.len() + 36);
    oriented_jpeg.extend_from_slice(&jpeg[..2]);
    oriented_jpeg.extend_from_slice(&[0xff, 0xe1, 0, 34]);
    oriented_jpeg.extend_from_slice(b"Exif\0\0");
    oriented_jpeg.extend_from_slice(&EXIF_ORIENTATION_6);
    oriented_jpeg.extend_from_slice(&jpeg[2..]);
    let jpeg_result = sanitize(&oriented_jpeg, "image/jpeg");
    assert_eq!(
        (jpeg_result.manifest.width, jpeg_result.manifest.height),
        (1, 2)
    );
    assert!(
        !jpeg_result
            .bytes
            .windows(6)
            .any(|window| window == b"Exif\0\0")
    );

    let mut gif = Vec::new();
    {
        let mut encoder = GifEncoder::new(&mut gif);
        encoder.encode_frame(Frame::new(red.clone())).unwrap();
        encoder
            .encode_frame(Frame::new(RgbaImage::from_pixel(
                2,
                1,
                Rgba([0, 0, 255, 255]),
            )))
            .unwrap();
    }
    let gif_result = sanitize(&gif, "image/gif");
    assert_eq!(gif_result.manifest.derivative_mime_type, "image/png");
    assert_eq!(
        image::load_from_memory(&gif_result.bytes)
            .unwrap()
            .to_rgba8()
            .get_pixel(0, 0)
            .0,
        [255, 0, 0, 255]
    );

    let webp = webp::Encoder::from_rgba(red.as_raw(), 2, 1)
        .encode_simple(false, 90.0)
        .unwrap()
        .to_vec();
    let webp_result = sanitize(&webp, "image/webp");
    assert_eq!(webp_result.manifest.derivative_mime_type, "image/webp");
    assert_eq!(
        (webp_result.manifest.width, webp_result.manifest.height),
        (2, 1)
    );
    let decoded_webp = image::load_from_memory(&webp_result.bytes).unwrap();
    assert_eq!((decoded_webp.width(), decoded_webp.height()), (2, 1));
    assert_eq!(
        webp_result.manifest.derivative_digest,
        format!("{:x}", Sha256::digest(&webp_result.bytes))
    );

    let mut legacy = webp_result.manifest;
    legacy.sanitizer_revision = "visual-derivative-sharp-v1".to_owned();
    verify_visual_manifest_source(
        &legacy,
        &webp,
        &ImageSourceRecord {
            size_bytes: webp.len(),
            sha256: &format!("{:x}", Sha256::digest(&webp)),
            storage_revision: "message-file-row-v1",
        },
    )
    .unwrap();
}

fn sanitize(bytes: &[u8], mime_type: &str) -> super::SanitizedImage {
    sanitize_image(ImageSanitizerInput {
        file_id: "file-1",
        safe_name: "image",
        mime_type,
        source_bytes: bytes,
        storage_revision: "message-file-row-v1",
        position: 0,
        limits: ImageSanitizerLimits::default(),
    })
    .unwrap()
}
