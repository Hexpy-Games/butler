//! Raster normalization and bounded, DNS-pinned public image downloads.
use image::{
    DynamicImage, ImageDecoder, ImageReader, codecs::jpeg::JpegEncoder, imageops::FilterType,
};
use std::{io::Cursor, time::Duration};
use url::Url;

pub const MAX_DOWNLOAD: usize = 8 * 1024 * 1024;
const MAX_DECODE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_ASSET: usize = 250 * 1024;
pub struct NormalizedImage {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub pixel_ratio: f64,
}

pub fn normalize(bytes: &[u8]) -> Result<NormalizedImage, &'static str> {
    if bytes.len() > MAX_DOWNLOAD {
        return Err("image_too_large");
    }
    let decoded = decode(bytes)?;
    let image = decoded.to_rgb8();
    for side in [1280, 960, 640, 320] {
        let long = image.width().max(image.height());
        let side = side.min(long);
        let scaled = |n: u32| {
            u32::try_from((u64::from(n) * u64::from(side) + u64::from(long) / 2) / u64::from(long))
                .unwrap_or(side)
                .max(1)
        };
        let width = scaled(image.width());
        let height = scaled(image.height());
        let resized = image::imageops::resize(&image, width, height, FilterType::Lanczos3);
        for quality in [75, 60, 45, 30] {
            let mut bytes = Vec::new();
            JpegEncoder::new_with_quality(&mut bytes, quality)
                .encode_image(&resized)
                .map_err(|_| "invalid_image")?;
            if bytes.len() <= MAX_ASSET {
                return Ok(NormalizedImage {
                    bytes,
                    width,
                    height,
                    pixel_ratio: 1.0,
                });
            }
        }
    }
    Err("image_too_large")
}

fn decode(bytes: &[u8]) -> Result<DynamicImage, &'static str> {
    if oxideav_avif::probe(bytes) {
        return super::image_formats::avif(bytes);
    }
    if image::guess_format(bytes).is_err() {
        return super::image_formats::svg(bytes);
    }
    raster(bytes)
}

pub(super) fn raster(bytes: &[u8]) -> Result<DynamicImage, &'static str> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "invalid_image")?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|_| "invalid_image")?;
    if decoder.total_bytes() > MAX_DECODE_BYTES {
        return Err("invalid_image");
    }
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut decoded = DynamicImage::from_decoder(decoder).map_err(|_| "invalid_image")?;
    decoded.apply_orientation(orientation);
    Ok(decoded)
}

pub async fn fetch(raw: &str, referer: &str, user_agent: &str) -> Result<Vec<u8>, &'static str> {
    tokio::time::timeout(
        Duration::from_secs(10),
        fetch_inner(raw, referer, user_agent),
    )
    .await
    .map_err(|_| "image_timeout")?
}

async fn fetch_inner(raw: &str, referer: &str, user_agent: &str) -> Result<Vec<u8>, &'static str> {
    let mut url = Url::parse(raw).map_err(|_| "invalid_image_url")?;
    for _ in 0..5 {
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("invalid_image_url");
        }
        let host = url.host_str().ok_or("invalid_image_url")?.to_owned();
        let port = url.port_or_known_default().ok_or("invalid_image_url")?;
        let addresses = super::egress::public_addresses(&host, port)
            .await
            .map_err(|_| "private_image_url")?;
        let client = tokio::task::spawn_blocking(move || {
            butler_log::http::external(butler_log::http::Purpose::new("browser_image"))
                .no_proxy()
                .redirect(butler_log::http::RedirectPolicy::none())
                .resolve_to_addrs(&host, &addresses)
                .timeout(Duration::from_secs(10))
                .build()
        })
        .await
        .map_err(|_| "image_fetch_failed")?
        .map_err(|_| "image_fetch_failed")?;
        let mut request = client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, "image/*");
        if !user_agent.is_empty() {
            request = request.header(reqwest::header::USER_AGENT, user_agent);
        }
        if let Some(referer) = image_referer(referer, &url) {
            request = request.header(reqwest::header::REFERER, referer);
        }
        let mut response = request.send().await.map_err(|_| "image_fetch_failed")?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or("invalid_image_url")?;
            url = url.join(location).map_err(|_| "invalid_image_url")?;
            continue;
        }
        if !response.status().is_success() {
            return Err(match response.status().as_u16() {
                401 | 403 => "image_access_denied",
                404 | 410 => "image_not_found",
                _ => "image_http_failed",
            });
        }
        if !response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|mime| mime.starts_with("image/"))
        {
            return Err("invalid_image");
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_DOWNLOAD as u64)
        {
            return Err("image_too_large");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "image_fetch_failed")? {
            if bytes.len() + chunk.len() > MAX_DOWNLOAD {
                return Err("image_too_large");
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok(bytes);
    }
    Err("image_redirect_limit")
}

fn image_referer(raw: &str, target: &Url) -> Option<String> {
    let mut page = Url::parse(raw).ok()?;
    if !matches!(page.scheme(), "http" | "https")
        || (page.scheme() == "https" && target.scheme() == "http")
    {
        return None;
    }
    page.set_username("").ok()?;
    page.set_password(None).ok()?;
    page.set_fragment(None);
    if page.origin() != target.origin() {
        page.set_path("/");
        page.set_query(None);
    }
    Some(page.into())
}
