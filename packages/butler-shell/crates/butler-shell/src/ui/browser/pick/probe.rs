#[cfg(feature = "cef")]
use super::Item;
use super::{
    Hover,
    geometry::{edges, meet, n, same, shift},
    reader,
};
use crate::ui::browser::engine::TabId;
use gpui::AsyncApp;
use serde_json::{Value, json};

#[derive(Clone, Default)]
pub(super) struct Frame {
    pub(super) path: Vec<usize>,
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) clip: Option<Value>,
}
impl Frame {
    pub(super) fn nested(&self, value: &Value) -> Self {
        let mut path = self.path.clone();
        path.extend(
            value["path"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_u64().and_then(|i| usize::try_from(i).ok())),
        );
        let clip = shift(&edges(&value["clip"]), self.x, self.y);
        Self {
            path,
            x: self.x + n(&value["offset"], "x"),
            y: self.y + n(&value["offset"], "y"),
            clip: Some(self.clip.as_ref().map_or_else(
                || clip.clone(),
                |parent| {
                    meet(parent, &clip).unwrap_or_else(|| super::geometry::rect(0., 0., 0., 0.))
                },
            )),
        }
    }
    pub(super) fn place(&self, value: &Value) -> Option<Value> {
        if value.is_null() {
            return None;
        }
        let value = shift(value, self.x, self.y);
        self.clip
            .as_ref()
            .map_or_else(|| Some(value.clone()), |clip| meet(&value, clip))
    }
}
#[derive(Clone)]
pub(super) struct Level {
    pub(super) data: Value,
    pub(super) frame: Frame,
}
pub(super) async fn frame_at(page: &TabId, path: &[usize], cx: &AsyncApp) -> anyhow::Result<Frame> {
    let mut frame = Frame::default();
    for (depth, index) in path.iter().enumerate() {
        let mut value = reader::run(
            page,
            &path[..depth],
            json!({"op":"frame","index":index}),
            cx,
        )
        .await?;
        anyhow::ensure!(!value.is_null(), "frame gone");
        value["path"] = json!([index]);
        frame = frame.nested(&value);
    }
    Ok(frame)
}
pub(super) async fn probe(
    page: &TabId,
    x: f64,
    y: f64,
    preferred: Option<&str>,
    cx: &AsyncApp,
) -> anyhow::Result<Hover> {
    let mut frame = Frame::default();
    let mut at = (x, y);
    let mut found = Vec::new();
    for _ in 0..16 {
        let result = reader::run(
            page,
            &frame.path,
            json!({"op":"ladder","x":at.0,"y":at.1}),
            cx,
        )
        .await?;
        let descend = result["descend"].clone();
        found.push((result, frame.clone()));
        if descend.is_null() {
            break;
        }
        at = (n(&descend, "x"), n(&descend, "y"));
        frame = frame.nested(&descend);
    }
    let mut levels: Vec<Level> = Vec::new();
    let mut chosen = None;
    for (result, frame) in found.into_iter().rev() {
        let Some(items) = result["levels"].as_array() else {
            continue;
        };
        if chosen.is_none() && !items.is_empty() {
            let index = result["index"]
                .as_u64()
                .and_then(|i| usize::try_from(i).ok())
                .unwrap_or(0);
            chosen = items
                .get(index)
                .and_then(|v| v["identity"].as_str())
                .map(str::to_owned);
        }
        for item in items {
            merge(&mut levels, item, &frame, &mut chosen);
        }
    }
    let preferred = preferred.filter(|id| levels.iter().any(|v| v.data["identity"] == *id));
    let index = levels
        .iter()
        .position(|v| v.data["identity"].as_str() == preferred.or(chosen.as_deref()))
        .unwrap_or(0);
    let mut hover = Hover {
        levels,
        index,
        rect: Value::Null,
        label: String::new(),
    };
    label(&mut hover);
    Ok(hover)
}
pub(super) fn label(hover: &mut Hover) {
    if let Some(level) = hover.levels.get(hover.index) {
        hover.rect = level.data["rect"].clone();
        hover.label = format!(
            "{} · {:.0} × {:.0}{}{}",
            level.data["name"].as_str().unwrap_or(""),
            n(&hover.rect, "width"),
            n(&hover.rect, "height"),
            if hover.index + 1 < hover.levels.len() {
                " · ↑"
            } else if hover.index > 0 {
                " · "
            } else {
                ""
            },
            if hover.index > 0 { "↓" } else { "" }
        );
    }
}
#[cfg(feature = "cef")]
pub(super) async fn hit(page: &TabId, hover: &Hover, cx: &AsyncApp) -> anyhow::Result<Item> {
    let level = hover
        .levels
        .get(hover.index)
        .ok_or_else(|| anyhow::anyhow!("nothing pickable"))?;
    let mut data = reader::run(
        page,
        &level.frame.path,
        json!({"op":"capture","id":level.data["id"]}),
        cx,
    )
    .await?;
    anyhow::ensure!(!data.is_null(), "element gone");
    data["rect"] = level
        .frame
        .place(&data["rect"])
        .ok_or_else(|| anyhow::anyhow!("offscreen"))?;
    data["cropRect"] = level
        .frame
        .place(&data["cropRect"])
        .ok_or_else(|| anyhow::anyhow!("offscreen"))?;
    let media=reader::evaluate(page,&level.frame.path,format!("(()=>{{const el=globalThis.__butlerPick?.refs.get({})?.deref();const image=el?.matches('img,video')?el:el?.querySelector('img,video');return image?.currentSrc||image?.src||null}})()",level.data["id"]),cx).await?;
    if media.is_string() {
        data["imageSrc"] = media;
    }
    let masks = masks(page, &level.frame, &data, cx).await?;
    data["crop"] = json!(super::crop::capture(page, &data["cropRect"], masks, cx).await?);
    if let Some(data) = data.as_object_mut() {
        data.remove("masks");
        data.remove("frames");
    }
    decorate(page, &mut data, cx)?;
    Ok(Item {
        data,
        frame: level.frame.clone(),
        hidden: false,
        area: None,
    })
}
#[cfg(feature = "cef")]
pub(super) fn decorate(page: &TabId, data: &mut Value, cx: &AsyncApp) -> anyhow::Result<()> {
    let url = cx
        .update(|cx| {
            cx.global::<crate::ui::browser::model::BrowserState>()
                .tab(page)
                .map(|t| t.url.clone())
        })
        .ok_or_else(|| anyhow::anyhow!("page closed"))?;
    data["id"] = json!(uuid::Uuid::new_v4().to_string());
    data["tab"] = json!(page.0);
    let parsed = url::Url::parse(&url)?;
    data["site"] = json!(&parsed[url::Position::BeforeHost..url::Position::AfterPort]);
    data["url"] = json!(url);
    data["capturedAt"] = json!(chrono::Utc::now().to_rfc3339());
    Ok(())
}
#[cfg(feature = "cef")]
pub(super) async fn masks(
    page: &TabId,
    frame: &Frame,
    data: &Value,
    cx: &AsyncApp,
) -> anyhow::Result<Vec<Value>> {
    let mut masks: Vec<_> = data["masks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| frame.place(v))
        .collect();
    let mut pending: Vec<_> = data["frames"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| frame.nested(v))
        .collect();
    while let Some(frame) = pending.pop() {
        match reader::run(page, &frame.path, json!({"op":"masks"}), cx).await {
            Ok(data) if !data.is_null() => {
                masks.extend(
                    data["masks"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|v| frame.place(v)),
                );
                pending.extend(
                    data["frames"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|v| frame.nested(v)),
                );
            }
            _ => masks.extend(frame.clip),
        }
    }
    Ok(masks)
}

fn merge(levels: &mut Vec<Level>, item: &Value, frame: &Frame, chosen: &mut Option<String>) {
    let Some(rect) = frame.place(&item["rect"]) else {
        return;
    };
    let mut data = item.clone();
    data["rect"] = rect;
    if let Some(last) = levels.last()
        && same(&last.data["rect"], &data["rect"], 2.)
    {
        let generic = |v: &Value| matches!(v["name"].as_str(), Some("div" | "span"));
        if generic(&data) && !generic(&last.data) {
            if chosen.as_deref() == data["identity"].as_str() {
                *chosen = last.data["identity"].as_str().map(str::to_owned);
            }
            return;
        }
        if chosen.as_deref() == last.data["identity"].as_str() {
            *chosen = data["identity"].as_str().map(str::to_owned);
        }
        levels.pop();
    }
    levels.push(Level {
        data,
        frame: frame.clone(),
    });
}
