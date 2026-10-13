//! Memory-only codecs; SVG resource resolvers cannot read files or the network.
use image::{DynamicImage, RgbaImage};
use resvg::{tiny_skia, usvg};
use std::{
    io::Cursor,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

pub(super) fn avif(bytes: &[u8]) -> Result<DynamicImage, &'static str> {
    let options = oxideav_avif::DecodeOptions::default()
        .with_max_width(Some(16384))
        .with_max_height(Some(16384))
        .with_max_pixels(Some(128 * 1024 * 1024 / 4))
        .with_max_bytes(Some(super::image_assets::MAX_DOWNLOAD as u64));
    let decoded = oxideav_avif::decode_with(bytes, &options).map_err(|_| "invalid_image")?;
    let pixels = decoded.try_to_rgba8().map_err(|_| "invalid_image")?;
    RgbaImage::from_raw(decoded.width(), decoded.height(), pixels)
        .map(DynamicImage::ImageRgba8)
        .ok_or("invalid_image")
}

pub(super) fn svg(bytes: &[u8]) -> Result<DynamicImage, &'static str> {
    svg_nested(bytes, 0)
}

fn svg_nested(bytes: &[u8], depth: usize) -> Result<DynamicImage, &'static str> {
    if depth > 8 || bytes.len() > super::image_assets::MAX_DOWNLOAD {
        return Err("invalid_image");
    }
    super::svg_limits::input(bytes)?;
    let failed = AtomicBool::new(false);
    let embedded_bytes = AtomicU64::new(0);
    let options = usvg::Options {
        resources_dir: None,
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: Box::new(|mime, data, _| {
                if failed.load(Ordering::Relaxed) {
                    return None;
                }
                match embedded(mime, &data, depth) {
                    Ok((png, allocation))
                        if embedded_bytes.fetch_add(allocation, Ordering::Relaxed) + allocation
                            <= 128 * 1024 * 1024 =>
                    {
                        Some(usvg::ImageKind::PNG(Arc::new(png)))
                    }
                    _ => {
                        failed.store(true, Ordering::Relaxed);
                        None
                    }
                }
            }),
            resolve_string: Box::new(|_, _| None),
        },
        fontdb: fonts(),
        font_family: "Noto Sans KR".into(),
        ..Default::default()
    };
    let tree = usvg::Tree::from_data(bytes, &options).map_err(|_| "invalid_image")?;
    if failed.load(Ordering::Relaxed) {
        return Err("invalid_image");
    }
    render(&tree, depth == 0)
}

fn render(tree: &usvg::Tree, white: bool) -> Result<DynamicImage, &'static str> {
    let size = tree.size();
    if size.width() > 16384.0
        || size.height() > 16384.0
        || f64::from(size.width()) * f64::from(size.height()) * 4.0 > 128.0 * 1024.0 * 1024.0
    {
        return Err("invalid_image");
    }
    let scale = (1280.0 / size.width().max(size.height())).min(1.0);
    super::svg_limits::layers(tree, scale)?;
    let scaled = size.scale_by(scale).ok_or("invalid_image")?.to_int_size();
    let (width, height) = (scaled.width(), scaled.height());
    let mut pixels = tiny_skia::Pixmap::new(width, height).ok_or("invalid_image")?;
    // Composite onto white before JPEG encoding, including transparent SVG regions.
    if white {
        pixels.fill(tiny_skia::Color::WHITE);
    }
    resvg::render(
        tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixels.as_mut(),
    );
    let bytes = pixels
        .pixels()
        .iter()
        .flat_map(|p| {
            let p = p.demultiply();
            [p.red(), p.green(), p.blue(), p.alpha()]
        })
        .collect();
    RgbaImage::from_raw(width, height, bytes)
        .map(DynamicImage::ImageRgba8)
        .ok_or("invalid_image")
}

fn fonts() -> Arc<usvg::fontdb::Database> {
    static FONTS: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();
    FONTS
        .get_or_init(|| {
            let mut db = usvg::fontdb::Database::new();
            db.load_font_data(include_bytes!("../../assets/NotoSansKR.ttf").to_vec());
            db.set_sans_serif_family("Noto Sans KR");
            db.set_serif_family("Noto Sans KR");
            db.set_monospace_family("Noto Sans KR");
            Arc::new(db)
        })
        .clone()
}

fn embedded(mime: &str, bytes: &[u8], depth: usize) -> Result<(Vec<u8>, u64), &'static str> {
    if bytes.len() > super::image_assets::MAX_DOWNLOAD {
        return Err("invalid_image");
    }
    let image = if mime == "image/svg+xml" {
        svg_nested(bytes, depth + 1)?
    } else if oxideav_avif::probe(bytes) {
        avif(bytes)?
    } else {
        super::image_assets::raster(bytes)?
    };
    let allocation = u64::from(image.width()) * u64::from(image.height()) * 4;
    let mut png = Cursor::new(Vec::new());
    image
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|_| "invalid_image")?;
    Ok((png.into_inner(), allocation))
}
