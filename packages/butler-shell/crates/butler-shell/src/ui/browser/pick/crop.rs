//! Captures stay masked before they leave the selection boundary, including unreadable frames.
use super::geometry::meet;
#[cfg(feature = "cef")]
use super::geometry::shift;
#[cfg(feature = "cef")]
use super::{
    Item,
    probe::{self, Frame},
};
use super::{geometry::n, reader};
use crate::ui::browser::engine::TabId;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use gpui::AsyncApp;
use serde_json::{Value, json};

pub(super) async fn capture(
    page: &TabId,
    rect: &Value,
    masks: Vec<Value>,
    cx: &AsyncApp,
) -> anyhow::Result<String> {
    let data = screenshot(page, rect, cx).await?;
    let rect = rect.clone();
    cx.background_executor()
        .spawn(async move { mask(&data, &rect, &masks) })
        .await
}
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "pixel bounds are clamped to the decoded image"
)]
fn mask(data: &str, rect: &Value, masks: &[Value]) -> anyhow::Result<String> {
    let mut image = image::load_from_memory(&STANDARD.decode(data)?)?.to_rgb8();
    let (width, height) = image.dimensions();
    let fx = f64::from(width) / n(rect, "width");
    let fy = f64::from(height) / n(rect, "height");
    for mask in masks {
        let x = ((n(mask, "x") - n(rect, "x")) * fx)
            .floor()
            .clamp(0., f64::from(width)) as u32;
        let y = ((n(mask, "y") - n(rect, "y")) * fy)
            .floor()
            .clamp(0., f64::from(height)) as u32;
        let right = ((n(mask, "x") + n(mask, "width") - n(rect, "x")) * fx)
            .ceil()
            .clamp(0., f64::from(width)) as u32;
        let bottom = ((n(mask, "y") + n(mask, "height") - n(rect, "y")) * fy)
            .ceil()
            .clamp(0., f64::from(height)) as u32;
        for y in y..bottom {
            for x in x..right {
                image.put_pixel(x, y, image::Rgb([217, 217, 217]));
            }
        }
    }
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 85).encode_image(&image)?;
    Ok(format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes)))
}
#[cfg(feature = "cef")]
pub(super) async fn area(page: &TabId, rect: Value, cx: &AsyncApp) -> anyhow::Result<Item> {
    let viewport = cx
        .update(|cx| {
            cx.global::<crate::ui::browser::model::BrowserState>()
                .tab(page)
                .map(|t| t.pick.viewport.get())
        })
        .ok_or_else(|| anyhow::anyhow!("page closed"))?;
    let rect = meet(
        &rect,
        &super::geometry::rect(0., 0., viewport.0, viewport.1),
    )
    .ok_or_else(|| anyhow::anyhow!("area offscreen"))?;
    let frame = Frame::default();
    let mut data = reader::run(page, &[], json!({"op":"area","rect":rect}), cx).await?;
    let mut text = data["text"].as_str().unwrap_or_default().to_owned();
    let mut contains = data["contains"].as_array().cloned().unwrap_or_default();
    let masks = probe::masks(page, &frame, &data, cx).await?;
    let mut pending: std::collections::VecDeque<_> = data["frames"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| frame.nested(v))
        .collect();
    while let Some(frame) = pending.pop_front() {
        let local = frame
            .clip
            .as_ref()
            .and_then(|clip| meet(&rect, clip))
            .map(|v| shift(&v, -frame.x, -frame.y));
        let Some(local) = local else {
            continue;
        };
        if let Ok(inner) =
            reader::run(page, &frame.path, json!({"op":"area","rect":local}), cx).await
        {
            if let Some(value) = inner["text"].as_str().filter(|v| !v.is_empty()) {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(value);
            }
            contains.extend(inner["contains"].as_array().into_iter().flatten().cloned());
            pending.extend(
                inner["frames"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|v| frame.nested(v)),
            );
        }
    }
    let scroll = (n(&data["scroll"], "x"), n(&data["scroll"], "y"));
    let title = data["title"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| text.lines().next().filter(|s| !s.is_empty()))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{:.0} × {:.0}", n(&rect, "width"), n(&rect, "height")));
    data["title"] = json!(title.chars().take(200).collect::<String>());
    data["text"] = json!(text);
    data["contains"] = json!(contains);
    data["tag"] = json!("area");
    data["identity"] = json!(format!("area:{}", uuid::Uuid::new_v4()));
    data["rect"] = rect.clone();
    data["cropRect"] = rect.clone();
    data["crop"] = json!(capture(page, &rect, masks, cx).await?);
    if let Some(data) = data.as_object_mut() {
        data.remove("masks");
        data.remove("frames");
        data.remove("scroll");
    }
    probe::decorate(page, &mut data, cx)?;
    Ok(Item {
        data,
        frame,
        hidden: false,
        area: Some(super::Area { rect, scroll }),
    })
}

async fn screenshot(page: &TabId, rect: &Value, cx: &AsyncApp) -> anyhow::Result<String> {
    let clip = json!({ "x":n(rect,"x"),"y":n(rect,"y"),"width":n(rect,"width"),"height":n(rect,"height"),"scale":1 });
    let shot = reader::protocol(
        page,
        "Page.captureScreenshot",
        json!({"format":"png","clip":clip,"captureBeyondViewport":false}),
        cx,
    )
    .await?;
    let data = shot["data"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("empty capture"))?
        .to_owned();
    Ok(data)
}

pub(super) async fn island(
    page: &TabId,
    rect: &Value,
    clip: Option<&Value>,
    masks: Vec<Value>,
    cx: &AsyncApp,
) -> anyhow::Result<String> {
    let viewport = cx
        .update(|cx| {
            cx.global::<crate::ui::browser::model::BrowserState>()
                .tab(page)
                .map(|t| t.pick.viewport.get())
        })
        .ok_or_else(|| anyhow::anyhow!("page closed"))?;
    let shown = meet(rect, &super::geometry::rect(0., 0., viewport.0, viewport.1))
        .and_then(|r| clip.map_or_else(|| Some(r.clone()), |c| meet(&r, c)))
        .ok_or_else(|| anyhow::anyhow!("island offscreen"))?;
    let data = screenshot(page, &shown, cx).await?;
    let rect = rect.clone();
    cx.background_executor()
        .spawn(async move { island_png(&data, &rect, &shown, &masks) })
        .await
}
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "image dimensions are bounded to 16 million pixels and mask coordinates clamped"
)]
fn island_png(data: &str, rect: &Value, shown: &Value, masks: &[Value]) -> anyhow::Result<String> {
    let piece = image::load_from_memory(&STANDARD.decode(data)?)?.to_rgba8();
    let fx = f64::from(piece.width()) / n(shown, "width");
    let fy = f64::from(piece.height()) / n(shown, "height");
    let width = (n(rect, "width") * fx).round().max(1.);
    let height = (n(rect, "height") * fy).round().max(1.);
    anyhow::ensure!(width * height <= 16e6, "island too large");
    let mut image = image::RgbaImage::new(width as u32, height as u32);
    let dx = ((n(shown, "x") - n(rect, "x")) * fx).round() as i64;
    let dy = ((n(shown, "y") - n(rect, "y")) * fy).round() as i64;
    image::imageops::overlay(&mut image, &piece, dx, dy);
    for mask in masks {
        let x = ((n(mask, "x") - n(rect, "x")) * fx)
            .floor()
            .clamp(0., width) as u32;
        let y = ((n(mask, "y") - n(rect, "y")) * fy)
            .floor()
            .clamp(0., height) as u32;
        let right = ((n(mask, "x") + n(mask, "width") - n(rect, "x")) * fx)
            .ceil()
            .clamp(0., width) as u32;
        let bottom = ((n(mask, "y") + n(mask, "height") - n(rect, "y")) * fy)
            .ceil()
            .clamp(0., height) as u32;
        for y in y..bottom {
            for x in x..right {
                image.put_pixel(x, y, image::Rgba([217, 217, 217, 255]));
            }
        }
    }
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png)?;
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(bytes.into_inner())
    ))
}
