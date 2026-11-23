//! The picked box as a JPEG at quality 85, read by DevTools from the page's compositor, not from the OSR frame.

use super::{geometry::n, reader};
use crate::ui::browser::engine::TabId;
use gpui::AsyncApp;
use serde_json::{Value, json};

/// The crop of `rect` (viewport CSS px) as a `data:image/jpeg;base64,` URL.
pub(super) async fn shot(page: &TabId, rect: &Value, cx: &AsyncApp) -> anyhow::Result<String> {
    let metrics = reader::protocol(page, "Page.getLayoutMetrics", json!({}), cx).await?;
    let view = &metrics["cssVisualViewport"];
    let params =
        json!({"format":"jpeg","quality":85,"clip":clip(rect, n(view, "pageX"), n(view, "pageY"))});
    let shot = reader::protocol(page, "Page.captureScreenshot", params, cx).await?;
    let data = shot["data"]
        .as_str()
        .filter(|d| !d.is_empty())
        .ok_or_else(|| anyhow::anyhow!("empty crop"))?;
    Ok(format!("data:image/jpeg;base64,{data}"))
}

/// Snapped outward to whole CSS px (Electron floors the origin and ceils the far edges), then
/// placed in the document, where `captureScreenshot` reads its clip. `scale: 1` keeps the page's
/// own device pixels, as `capturePage` of the view does; Electron caps no crop size.
pub(super) fn clip(rect: &Value, scroll_x: f64, scroll_y: f64) -> Value {
    let (x, y) = (n(rect, "x").floor(), n(rect, "y").floor());
    let width = (n(rect, "x") + n(rect, "width")).ceil() - x;
    let height = (n(rect, "y") + n(rect, "height")).ceil() - y;
    json!({"x": x + scroll_x, "y": y + scroll_y, "width": width, "height": height, "scale": 1})
}
