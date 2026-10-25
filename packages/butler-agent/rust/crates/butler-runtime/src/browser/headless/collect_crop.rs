//! Collection regions are CSS pixels even without an observation screenshot.
use super::{
    capture::{self, Rect},
    page::Page,
};
use serde_json::{Value, json};
pub(crate) async fn capture(page: &Page, args: &Value, epoch: u64) -> Result<Value, String> {
    let region = args["region"].as_array().ok_or("invalid_region")?;
    if region.len() != 4 {
        return Err("invalid_region".into());
    }
    let coords = region
        .iter()
        .map(|v| v.as_f64().filter(|v| v.is_finite()).ok_or("invalid_region"))
        .collect::<Result<Vec<_>, _>>()?;
    let rect = Rect {
        x: coords[0],
        y: coords[1],
        width: coords[2],
        height: coords[3],
    };
    let viewport = page.viewport().await?;
    if rect.x < 0.0
        || rect.y < 0.0
        || rect.width <= 0.0
        || rect.height <= 0.0
        || rect.x + rect.width > viewport["width"].as_f64().unwrap_or(0.0)
        || rect.y + rect.height > viewport["height"].as_f64().unwrap_or(0.0)
    {
        return Ok(json!({"status":"refused","reason":"invalid_region"}));
    }
    if capture::secure_boxes(page)
        .await?
        .iter()
        .any(|secure| rect.overlaps(*secure))
    {
        return Ok(json!({"status":"refused","reason":"secure_field"}));
    }
    let clip = capture::clip(page, rect, 1.0).await?;
    let data = page
        .capture(
            json!({"format":"png","clip":clip,"fromSurface":true,"captureBeyondViewport":false}),
        )
        .await
        .ok_or("image_unavailable")?;
    if page.epoch() != Some(epoch) {
        return Err("control_changed".into());
    }
    let url = page
        .shared
        .with_tab(&page.tab, |t| t.url.clone())
        .unwrap_or_default();
    Ok(
        json!({"status":"ok","pixel_ratio":1,"source_url":url,"alt":"","nearby_text":"","image":{"data":data}}),
    )
}
