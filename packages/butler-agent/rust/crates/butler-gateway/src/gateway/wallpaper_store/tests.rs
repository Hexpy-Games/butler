use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::codecs::webp::WebPEncoder;
use image::{DynamicImage, ImageEncoder, ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};

use super::pipeline::{MAX_INPUT_BYTES, process};
use super::*;
use crate::gateway::{AppWallpaperVariant, GatewayApplicationError};

fn png(image: &RgbaImage) -> Vec<u8> {
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .unwrap();
    bytes
}

fn jpeg(image: &RgbImage) -> Vec<u8> {
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 95)
        .encode_image(image)
        .unwrap();
    bytes
}

fn webp(image: &RgbaImage) -> Vec<u8> {
    let mut bytes = Vec::new();
    WebPEncoder::new_lossless(&mut bytes)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .unwrap();
    bytes
}

fn solid(width: u32, height: u32, color: [u8; 4]) -> RgbaImage {
    RgbaImage::from_pixel(width, height, Rgba(color))
}

fn decode(bytes: &[u8]) -> DynamicImage {
    image::load_from_memory(bytes).unwrap()
}

fn rejection(source: &[u8]) -> (u16, String) {
    match process(source) {
        Err(GatewayApplicationError::Public { status, code, .. }) => (status, code),
        Err(other) => panic!("expected a public rejection, got {other:?}"),
        Ok(_) => panic!("expected a rejection"),
    }
}

/// Inserts an EXIF APP1 segment with `orientation` right after the JPEG SOI.
fn with_exif_orientation(jpeg: &[u8], orientation: u8) -> Vec<u8> {
    let tiff: [u8; 26] = [
        b'I',
        b'I',
        42,
        0,
        8,
        0,
        0,
        0, // little-endian header, IFD at 8
        1,
        0, // one entry
        0x12,
        0x01,
        3,
        0,
        1,
        0,
        0,
        0,
        orientation,
        0,
        0,
        0, // Orientation, SHORT
        0,
        0,
        0,
        0, // no next IFD
    ];
    let length = u16::try_from(2 + 6 + tiff.len()).unwrap().to_be_bytes();
    let mut output = jpeg[..2].to_vec();
    output.extend_from_slice(&[0xFF, 0xE1, length[0], length[1]]);
    output.extend_from_slice(b"Exif\0\0");
    output.extend_from_slice(&tiff);
    output.extend_from_slice(&jpeg[2..]);
    output
}

/// Rewrites the frame size of a baseline JPEG without touching its data.
fn with_frame_size(jpeg: &[u8], width: u16, height: u16) -> Vec<u8> {
    let mut output = jpeg.to_vec();
    let sof = output
        .windows(2)
        .position(|marker| marker == [0xFF, 0xC0])
        .unwrap();
    output[sof + 5..sof + 7].copy_from_slice(&height.to_be_bytes());
    output[sof + 7..sof + 9].copy_from_slice(&width.to_be_bytes());
    output
}

#[test]
fn type_is_detected_from_content_and_only_jpeg_png_webp_are_accepted() {
    let image = solid(8, 4, [10, 120, 200, 255]);
    for source in [
        png(&image),
        jpeg(&DynamicImage::ImageRgba8(image.clone()).to_rgb8()),
        webp(&image),
    ] {
        let processed = process(&source).unwrap();
        assert_eq!((processed.image.width, processed.image.height), (8, 4));
    }
    let mut gif = Vec::new();
    DynamicImage::ImageRgba8(image)
        .write_to(&mut Cursor::new(&mut gif), ImageFormat::Gif)
        .unwrap();
    for source in [gif, b"just some text pretending to be image/png".to_vec()] {
        assert_eq!(
            rejection(&source),
            (415, "wallpaper_unsupported_type".into())
        );
    }
    let mut corrupt = b"\x89PNG\r\n\x1a\n".to_vec();
    corrupt.extend_from_slice(&[0; 64]);
    assert_eq!(rejection(&corrupt), (400, "wallpaper_image_invalid".into()));
    assert_eq!(rejection(&[]), (400, "wallpaper_image_invalid".into()));
}

#[test]
fn input_over_25_mib_is_rejected_before_decoding() {
    let mut source = b"\x89PNG\r\n\x1a\n".to_vec();
    source.resize(MAX_INPUT_BYTES + 1, 0);
    assert_eq!(rejection(&source), (413, "wallpaper_too_large".into()));
    source.truncate(MAX_INPUT_BYTES);
    assert_eq!(rejection(&source), (400, "wallpaper_image_invalid".into()));
}

#[test]
fn absurd_dimensions_are_rejected_from_the_header() {
    let small = jpeg(&RgbImage::from_pixel(8, 8, Rgb([1, 2, 3])));
    // 100 megapixels: within the side limit, over the pixel budget.
    let huge = with_frame_size(&small, 10_000, 10_000);
    assert_eq!(
        rejection(&huge),
        (400, "wallpaper_dimensions_unsupported".into())
    );
    let wide = png(&solid(16_385, 1, [0, 0, 0, 255]));
    assert_eq!(
        rejection(&wide),
        (400, "wallpaper_dimensions_unsupported".into())
    );
}

#[test]
fn images_are_reencoded_within_3840_keeping_aspect_with_a_480_thumbnail() {
    let cases = [
        ((7680, 80), (3840, 40), (480, 5)),
        ((80, 7680), (40, 3840), (5, 480)),
        ((1920, 960), (1920, 960), (480, 240)),
        ((64, 32), (64, 32), (64, 32)),
    ];
    for ((width, height), image_size, thumbnail_size) in cases {
        let processed = process(&png(&solid(width, height, [40, 80, 120, 255]))).unwrap();
        assert_eq!((processed.image.width, processed.image.height), image_size);
        assert_eq!(
            decode(&processed.image.bytes).to_rgb8().dimensions(),
            image_size
        );
        assert_eq!(
            (processed.thumbnail.width, processed.thumbnail.height),
            thumbnail_size
        );
        assert_eq!(
            decode(&processed.thumbnail.bytes).to_rgb8().dimensions(),
            thumbnail_size
        );
    }
}

#[test]
fn opaque_images_become_jpeg_and_transparent_images_stay_png() {
    let opaque = process(&png(&solid(16, 16, [9, 9, 9, 255]))).unwrap();
    assert_eq!(opaque.image.mime_type, "image/jpeg");
    assert_eq!(opaque.thumbnail.mime_type, "image/jpeg");
    assert!(opaque.image.bytes.starts_with(&[0xFF, 0xD8, 0xFF]));

    let mut translucent = solid(16, 16, [9, 9, 9, 255]);
    translucent.put_pixel(0, 0, Rgba([9, 9, 9, 0]));
    let processed = process(&webp(&translucent)).unwrap();
    assert_eq!(processed.image.mime_type, "image/png");
    assert_eq!(processed.thumbnail.mime_type, "image/png");
    let decoded = decode(&processed.image.bytes).to_rgba8();
    assert_eq!(decoded.get_pixel(0, 0)[3], 0);
    assert_eq!(decoded.get_pixel(1, 1)[3], 255);
}

#[test]
fn exif_orientation_is_applied_and_metadata_is_stripped() {
    // Left half red, right half blue; orientation 6 means "rotate 90° clockwise".
    let source = RgbImage::from_fn(40, 20, |x, _| {
        if x < 20 {
            Rgb([255, 0, 0])
        } else {
            Rgb([0, 0, 255])
        }
    });
    let tagged = with_exif_orientation(&jpeg(&source), 6);
    assert!(tagged.windows(4).any(|window| window == b"Exif"));
    let processed = process(&tagged).unwrap();
    assert_eq!((processed.image.width, processed.image.height), (20, 40));
    assert!(
        !processed
            .image
            .bytes
            .windows(4)
            .any(|window| window == b"Exif")
    );
    assert!(
        !processed
            .thumbnail
            .bytes
            .windows(4)
            .any(|window| window == b"Exif")
    );
    let decoded = decode(&processed.image.bytes).to_rgb8();
    let top = decoded.get_pixel(10, 5);
    let bottom = decoded.get_pixel(10, 35);
    assert!(top[0] > 200 && top[2] < 60, "top should be red: {top:?}");
    assert!(
        bottom[2] > 200 && bottom[0] < 60,
        "bottom should be blue: {bottom:?}"
    );
}

#[test]
fn luminance_and_color_average_the_visible_pixels() {
    let half = RgbaImage::from_fn(32, 32, |x, _| {
        if x < 16 {
            Rgba([0, 0, 0, 255])
        } else {
            Rgba([255, 255, 255, 255])
        }
    });
    let mut hidden = solid(32, 32, [255, 0, 0, 255]);
    for x in 0..16 {
        for y in 0..32 {
            hidden.put_pixel(x, y, Rgba([255, 255, 255, 0]));
        }
    }
    let cases = [
        (solid(8, 8, [255, 255, 255, 255]), 1.0, "#ffffff"),
        (solid(8, 8, [0, 0, 0, 255]), 0.0, "#000000"),
        (solid(8, 8, [255, 0, 0, 255]), 0.2126, "#ff0000"),
        // Linear-light average of black and white: luminance 0.5, sRGB #bcbcbc.
        (half, 0.5, "#bcbcbc"),
        // Fully transparent pixels do not count.
        (hidden, 0.2126, "#ff0000"),
    ];
    for (image, luminance, color) in cases {
        let processed = process(&png(&image)).unwrap();
        assert!(
            (processed.luminance - luminance).abs() < 0.001,
            "luminance {} != {luminance}",
            processed.luminance
        );
        assert_eq!(processed.color, color);
    }
}

#[tokio::test]
async fn store_writes_image_and_thumbnail_under_app_server_wallpapers() {
    let root =
        std::env::temp_dir().join(format!("butler-wallpaper-files-{}", uuid::Uuid::new_v4()));
    let files = AppWallpaperFiles::new(&root);
    let id = "wp_0123456789abcdef0123456789abcdef".to_owned();
    let stored = files
        .store(
            id.clone(),
            png(&solid(1000, 500, [200, 100, 50, 255])).into(),
        )
        .await
        .unwrap();
    assert_eq!((stored.width, stored.height), (1000, 500));
    assert_eq!(stored.mime_type, "image/jpeg");
    assert_eq!(stored.thumbnail_mime_type, "image/jpeg");
    let directory = root.join("app-server/wallpapers");
    let image_path = directory.join(format!("{id}.jpg"));
    let thumbnail_path = directory.join(format!("{id}.thumb.jpg"));
    assert_eq!(std::fs::metadata(&image_path).unwrap().len(), stored.bytes);
    let image = files
        .read(
            id.clone(),
            stored.mime_type.clone(),
            AppWallpaperVariant::Image,
        )
        .await
        .unwrap();
    assert_eq!(image.as_ref(), std::fs::read(&image_path).unwrap());
    let thumbnail = files
        .read(
            id.clone(),
            stored.thumbnail_mime_type.clone(),
            AppWallpaperVariant::Thumbnail,
        )
        .await
        .unwrap();
    assert_eq!(decode(&thumbnail).to_rgb8().dimensions(), (480, 240));
    assert_eq!(
        std::fs::read_dir(&directory).unwrap().count(),
        2,
        "no temporary files remain"
    );

    files
        .remove(
            id.clone(),
            stored.mime_type.clone(),
            stored.thumbnail_mime_type.clone(),
        )
        .await
        .unwrap();
    assert!(!image_path.exists() && !thumbnail_path.exists());
    // Removing again, or reading an unsafe name, never reaches outside the store.
    files
        .remove(id, stored.mime_type, stored.thumbnail_mime_type)
        .await
        .unwrap();
    assert!(
        files
            .read(
                "../escape".into(),
                "image/jpeg".into(),
                AppWallpaperVariant::Image
            )
            .await
            .is_err()
    );
    files.close().await;
    std::fs::remove_dir_all(root).unwrap();
}
