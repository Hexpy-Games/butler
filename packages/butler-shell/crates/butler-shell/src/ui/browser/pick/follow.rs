//! One suspended page watch per frame holding picks; a static document does no work.
use super::{
    geometry::{meet, n, shift},
    input, probe, reader,
};
use crate::ui::browser::{engine::TabId, model::BrowserState};
use gpui::{App, AsyncApp};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub(super) fn sync(id: &TabId, cx: &mut App) {
    let Some(tab) = cx.global::<BrowserState>().tab(id).cloned() else {
        return;
    };
    let session = tab.pick;
    let mut want = BTreeSet::new();
    if tab.picking || !tab.selections.is_empty() {
        want.insert(Vec::new());
        for item in &tab.selections {
            for depth in 1..=item.frame.path.len() {
                want.insert(item.frame.path[..depth].to_vec());
            }
        }
    }
    let old = std::mem::take(&mut *session.watches.borrow_mut());
    drop(old);
    // Superseding a watch releases its page-side promise; removed paths are explicitly unwatched.
    let paths: Vec<_> = session
        .worlds
        .borrow()
        .keys()
        .filter(|p| !want.contains(*p))
        .cloned()
        .collect();
    for path in paths {
        let id = id.clone();
        cx.spawn(async move |cx| {
            let _ = reader::run(&id, &path, json!({"op":"unwatch"}), cx).await;
        })
        .detach();
    }
    for path in want {
        let task = watch(id, path.clone(), session.generation.get(), cx);
        session.watches.borrow_mut().insert(path, task);
    }
}
fn watch(id: &TabId, path: Vec<usize>, generation: u64, cx: &mut App) -> gpui::Task<()> {
    let page = id.clone();

    cx.spawn(async move |cx| {
        loop {
            let tab = cx.update(|cx| cx.global::<BrowserState>().tab(&page).cloned());
            let Some(tab) = tab.filter(|t| t.pick.generation.get() == generation) else {
                break;
            };
            let identities: Vec<_> = tab
                .selections
                .iter()
                .filter(|p| p.frame.path == path)
                .map(|p| p.data["identity"].clone())
                .collect();
            let frames: BTreeSet<_> = tab
                .selections
                .iter()
                .filter(|p| p.frame.path.len() > path.len() && p.frame.path.starts_with(&path))
                .map(|p| p.frame.path[path.len()])
                .collect();
            let Ok(watch) = reader::begin(
                &page,
                &path,
                json!({"op":"watch","identities":identities,"frames":frames}),
                cx,
            )
            .await
            else {
                break;
            };
            if refresh(&page, cx).await.is_err() {
                break;
            }
            match watch
                .await
                .ok()
                .and_then(Result::ok)
                .and_then(|v| reader::decoded(&v).ok())
            {
                Some(value)
                    if !value.is_null() && value["gone"] != true && value["stopped"] != true => {}
                _ => break,
            }
            if refresh(&page, cx).await.is_err() {
                break;
            }
            cx.update(|cx| {
                if let Some(tab) = cx.global::<BrowserState>().tab(&page)
                    && tab.picking
                    && tab.pick.down.borrow().is_none()
                    && let Some((x, y)) = tab.pick.point.get()
                {
                    input::hover(&page, x, y, cx);
                }
            });
        }
    })
}

async fn refresh(page: &TabId, cx: &AsyncApp) -> anyhow::Result<()> {
    let tab = cx
        .update(|cx| cx.global::<BrowserState>().tab(page).cloned())
        .ok_or_else(|| anyhow::anyhow!("page closed"))?;
    let generation = tab.pick.generation.get();
    let paths: BTreeSet<_> = tab
        .selections
        .iter()
        .map(|p| p.frame.path.clone())
        .collect();
    let mut updated = tab.selections;
    for path in paths {
        let identities: Vec<_> = updated
            .iter()
            .filter(|p| p.frame.path == path && p.area.is_none())
            .map(|p| p.data["identity"].clone())
            .collect();
        let Ok((frame, found)) = measure_frame(page, &path, identities, cx).await else {
            for item in updated.iter_mut().filter(|p| p.frame.path == path) {
                item.data["gone"] = Value::Bool(true);
            }
            continue;
        };
        for item in updated.iter_mut().filter(|p| p.frame.path == path) {
            reposition(item, &frame, &found, tab.pick.viewport.get());
        }
    }
    let removed = updated.iter().any(|p| p.data["gone"] == true);
    cx.update(|cx| {
        if let Some(tab) = cx
            .global_mut::<BrowserState>()
            .tabs
            .iter_mut()
            .find(|t| &t.id == page && t.pick.generation.get() == generation)
        {
            // Refresh only the picks still present; a concurrent user pick keeps its order and data.
            for item in &mut tab.selections {
                if let Some(at) = updated.iter().find(|p| p.data["id"] == item.data["id"]) {
                    *item = at.clone();
                }
            }
            tab.selections.retain(|p| p.data["gone"] != true);
        }
        if removed {
            sync(page, cx);
        }
        cx.refresh_windows();
    });
    Ok(())
}

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
