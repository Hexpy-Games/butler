use super::{
    geometry::{meet, n, shift},
    probe, reader,
};
use crate::ui::browser::engine::TabId;
use gpui::AsyncApp;
use serde_json::{Value, json};
async fn measure_frame(
    page: &TabId,
    path: &[usize],
    identities: Vec<Value>,
    cx: &AsyncApp,
) -> anyhow::Result<(probe::Frame, Value)> {
    let frame = probe::frame_at(page, path, cx).await?;
    let found = reader::run(
        page,
        path,
        json!({"op":"rects","identities":identities}),
        cx,
    )
    .await?;
    anyhow::ensure!(!found.is_null(), "frame gone");
    Ok((frame, found))
}

fn reposition(item: &mut super::Item, frame: &probe::Frame, found: &Value, viewport: (f64, f64)) {
    if let Some(area) = &item.area {
        let rect = shift(
            &area.rect,
            area.scroll.0 - n(&found["scroll"], "x"),
            area.scroll.1 - n(&found["scroll"], "y"),
        );
        let (w, h) = viewport;
        item.hidden = meet(&rect, &super::geometry::rect(0., 0., w, h)).is_none();
        item.data["cropRect"] = rect.clone();
        item.data["rect"] = rect;
        return;
    }
    let identity = item.data["identity"].as_str().unwrap_or_default();
    let now = &found["picks"][identity];
    if now.is_null() || now["gone"] == true {
        item.data["gone"] = Value::Bool(true);
        return;
    }
    item.data["identity"] = now["identity"].clone();
    if let Some(rect) = frame.place(&now["rect"]) {
        item.hidden = false;
        let prior = &item.data["rect"];
        item.data["cropRect"] = shift(
            &item.data["cropRect"],
            n(&rect, "x") - n(prior, "x"),
            n(&rect, "y") - n(prior, "y"),
        );
        item.data["rect"] = rect;
        item.frame = frame.clone();
    } else {
        item.hidden = true;
    }
}
