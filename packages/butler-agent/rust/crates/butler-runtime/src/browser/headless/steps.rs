//! What a step reaches, resolved before anything is dispatched (the App
//! executor's `resolveStep`, `point.mjs`, `keyboard.mjs` focus and `drag.mjs`).
use super::{
    js::{jnum, js_string, num, round},
    names::accessible_name,
    page::Page,
    scripts::scripts,
    state::Observation,
};
use serde_json::{Value, json};
use std::sync::Arc;

pub(crate) const NAVIGATION: [&str; 3] = ["back", "forward", "reload"];

fn reason(value: &str) -> Value {
    json!({"reason":value})
}

pub(crate) fn current(page: &Page, obs: &Value) -> Option<Arc<Observation>> {
    page.shared
        .with_tab(&page.tab, |t| {
            t.observation
                .clone()
                .filter(|o| *obs == o.obs.as_str() && o.epoch == t.epoch)
        })
        .flatten()
}

fn same_origin(a: &str, b: &str) -> bool {
    match (url::Url::parse(a), url::Url::parse(b)) {
        (Ok(a), Ok(b)) => a.origin() == b.origin(),
        _ => false,
    }
}

async fn blocker(page: &Page, observation: &Observation, node: &Value) -> Value {
    let covered = node["coveredBy"].clone();
    let Some(frame) = observation.frame_of(&js_string(&node["ref"])) else {
        return json!({"ref":covered,"controls":[]});
    };
    let code = format!("(()=>{{const state=globalThis.__butlerObservation,element=state.refs.get({covered})?.deref();
    if(!element?.isConnected)return {{refs:[]}};
    return {{role:element.getAttribute('role')||element.localName,refs:[...state.refs].filter(([,weak])=>{{const child=weak.deref();return child&&element.contains(child)}}).map(([ref])=>ref)}}}})()");
    let value = page
        .evaluate(frame, &code)
        .await
        .unwrap_or_else(|_| json!({"refs":[]}));
    let refs = value["refs"].as_array().cloned().unwrap_or_default();
    let controls: Vec<Value> = observation
        .nodes
        .iter()
        .filter(|c| refs.contains(&c["ref"]) && c["actionable"] == true)
        .map(|c| json!({"ref":c["ref"],"role":c["role"],"name":c["name"]}))
        .collect();
    let mut out = json!({"ref":covered,"controls":controls});
    if !value["role"].is_null() {
        out["role"] = value["role"].clone();
    }
    out
}

/// A ref step: resolved, optionally scrolled into view, hit-tested at a visible point.
pub(crate) async fn resolve_step(
    page: &Page,
    obs: &Value,
    step: &Value,
    scroll: bool,
) -> Result<Value, String> {
    let Some(observation) = current(page, obs) else {
        return Ok(reason("stale_ref"));
    };
    let reference = js_string(&step["ref"]);
    let (Some(index), Some(node)) = (
        observation.bindings.get(&reference).copied(),
        observation.node(&reference),
    ) else {
        return Ok(reason("stale_ref"));
    };
    if node["actionable"] != true {
        if node["secure"] == true {
            return Ok(reason("secure_field"));
        }
        if !node["coveredBy"].is_null() {
            return Ok(
                json!({"reason":"blocked_by","blocker":blocker(page, &observation, node).await,
                "recovery":"Observe, select or dismiss the visible popup, then retry the field with a fresh ref."}),
            );
        }
        return Ok(reason("not_actionable"));
    }
    let frame = &observation.frames[index];
    let scripts = scripts().ok_or("page_scripts_unavailable")?;
    let mut input = json!({"ref":reference,"obs":obs,"epoch":observation.epoch,"scroll":scroll});
    if !step["pointOffset"].is_null() {
        input["offset"] = step["pointOffset"].clone();
    }
    let mut resolved = page.evaluate(frame, &scripts.resolve(&input)).await?;
    if resolved["reason"].is_null()
        && node["name_source"] == "accessibility"
        && let Some(name) = accessible_name(page, frame, &reference).await
    {
        resolved["hit"]["name"] = json!(name);
    }
    if frame.parent.is_some() && resolved["reason"].is_null() {
        let local = (num(&resolved["x"], 0.0), num(&resolved["y"], 0.0));
        let Some(point) = page.hit_frame(&observation.frames, index, local).await? else {
            return Ok(reason("blocked_by"));
        };
        if resolved["rect"].is_object() {
            resolved["rect"]["x"] = jnum(num(&resolved["rect"]["x"], 0.0) + point.0 - local.0);
            resolved["rect"]["y"] = jnum(num(&resolved["rect"]["y"], 0.0) + point.1 - local.1);
        }
        resolved["x"] = jnum(point.0);
        resolved["y"] = jnum(point.1);
    }
    let payment = resolved["payment"] == true || observation.payment;
    resolved["frame_payment"] =
        json!(frame.parent.is_some() && observation.payment_frames.contains(&index));
    resolved["payment"] = json!(payment);
    if resolved["addons"].is_null() {
        resolved["addons"] = json!([]);
    }
    Ok(resolved)
}

/// The observed main-frame control closest to a screenshot point, with its center.
fn nearest(observation: &Observation, point: (f64, f64)) -> Option<Value> {
    let g = observation.geometry?;
    let (sx, sy) = (g.width / g.css_width, g.height / g.css_height);
    let mut best: Option<(f64, &Value, [f64; 2])> = None;
    for node in &observation.nodes {
        if node["actionable"] != true
            || node["rect"].is_null()
            || observation.bindings.get(&js_string(&node["ref"])) != Some(&0)
        {
            continue;
        }
        let r = &node["rect"];
        let (left, top) = (num(&r["x"], 0.0) * sx, num(&r["y"], 0.0) * sy);
        let (right, bottom) = (
            left + num(&r["width"], 0.0) * sx,
            top + num(&r["height"], 0.0) * sy,
        );
        let distance = f64::hypot(
            f64::max(f64::max(left - point.0, 0.0), point.0 - right),
            f64::max(f64::max(top - point.1, 0.0), point.1 - bottom),
        );
        if distance <= 80.0 && best.as_ref().is_none_or(|b| distance < b.0) {
            best = Some((
                distance,
                node,
                [
                    round(f64::midpoint(left, right)),
                    round(f64::midpoint(top, bottom)),
                ],
            ));
        }
    }
    best.map(|(distance, node, center)| {
        json!({"ref":node["ref"],"role":node["role"],"name":node["name"],"point":[jnum(center[0]),jnum(center[1])],"distance":jnum(round(distance)),"kind":"untrusted_web_page_data"})
    })
}

fn point_refusal(
    observation: &Observation,
    point: &Value,
    expect: &str,
    mut result: Value,
    origin: (f64, f64),
) -> Value {
    let kind = js_string(&result["reason"]);
    if !matches!(
        kind.as_str(),
        "point_mismatch" | "not_actionable" | "transparent_overlay" | "disabled" | "blocked_by"
    ) {
        return result;
    }
    let Some(g) = observation.geometry else {
        return result;
    };
    let (sx, sy) = (g.width / g.css_width, g.height / g.css_height);
    let had_ref = !result["hit"]["ref"].is_null();
    if result["hit"].is_object() {
        result["hit"]["kind"] = json!("untrusted_web_page_data");
        if result["hit"]["rect"].is_object() {
            let r = result["hit"]["rect"].clone();
            result["hit"]["rect"] = json!([
                jnum(round((num(&r["x"], 0.0) + origin.0) * sx)),
                jnum(round((num(&r["y"], 0.0) + origin.1) * sy)),
                jnum(round(num(&r["width"], 0.0) * sx)),
                jnum(round(num(&r["height"], 0.0) * sy))
            ]);
        }
    }
    let at = (num(&point[0], 0.0), num(&point[1], 0.0));
    let close = nearest(observation, at);
    let lower = expect.to_lowercase();
    let canvas = lower
        .strip_prefix("canvas")
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace));
    let hit = if result["hit"].is_object() {
        "the element in hit (role, name, class_words, screenshot rect [x,y,width,height])"
    } else {
        "no element that accepts input"
    };
    let refused = if kind == "not_actionable" {
        "it does not accept input. "
    } else {
        ""
    };
    let near = if close.is_some() {
        "nearest is the closest observed control and its screenshot point: use nearest.ref if it is the intended control."
    } else {
        "no observed control is near; observe again or choose a visible ref."
    };
    let generic = format!("The point reached {hit}; {refused}{near} No steps were dispatched.");
    let recovery = if canvas && !had_ref {
        "This screenshot point does not hit the observed canvas. NO steps in the batch were dispatched, including earlier steps. This is coordinate validation, not an input delivery failure. Keep every point inside one canvas: left<=x<right, top<=y<bottom in capture_regions.bounds (a region is [x,y,width,height], so its bottom is y+height). Then resend the whole batch.".to_owned()
    } else if let Some(own) = result["recovery"].as_str() {
        format!("{own} {generic}")
    } else {
        generic
    };
    if let Some(close) = close {
        result["nearest"] = close;
    }
    result["rejected_point"] = point.clone();
    result["image_geometry"] = g.to_value();
    result["untrusted_content"] =
        json!({"kind":"web_page_data","capture_regions":observation.capture_regions});
    result["recovery"] = json!(recovery);
    result
}

/// The point's hit inside frame `index`, checked against `expect`.
async fn framed_hit(
    page: &Page,
    observation: &Observation,
    index: usize,
    (point, expect): (&Value, &str),
    css: (f64, f64),
    origin: (f64, f64),
) -> Result<Value, String> {
    let scripts = scripts().ok_or("page_scripts_unavailable")?;
    let frame = &observation.frames[index];
    let local = (css.0 - origin.0, css.1 - origin.1);
    let mut result = page
        .evaluate(
            frame,
            &scripts.point(&json!({"x":local.0,"y":local.1,"expect":expect})),
        )
        .await?;
    if !result["reason"].is_null() {
        return Ok(point_refusal(observation, point, expect, result, origin));
    }
    let reference = js_string(&result["hit"]["ref"]);
    if observation
        .node(&reference)
        .is_some_and(|n| n["name_source"] == "accessibility")
    {
        if let Some(name) = accessible_name(page, frame, &reference).await {
            result["hit"]["name"] = json!(name);
        }
        let name = js_string(&result["hit"]["name"]).to_lowercase();
        if !expect
            .trim()
            .to_lowercase()
            .split_whitespace()
            .skip(1)
            .all(|word| name.contains(word))
        {
            return Ok(point_refusal(
                observation,
                point,
                expect,
                json!({"reason":"point_mismatch","hit":result["hit"]}),
                origin,
            ));
        }
    }
    result["x"] = jnum(css.0);
    result["y"] = jnum(css.1);
    result["rect"]["x"] = jnum(num(&result["rect"]["x"], 0.0) + origin.0);
    result["rect"]["y"] = jnum(num(&result["rect"]["y"], 0.0) + origin.1);
    result["payment"] = json!(result["payment"] == true || observation.payment);
    result["frame_payment"] =
        json!(frame.parent.is_some() && observation.payment_frames.contains(&index));
    Ok(result)
}

/// A point step: mapped from screenshot coordinates and hit-tested across frames.
pub(crate) async fn resolve_point(
    page: &Page,
    obs: &Value,
    point: &Value,
    expect: &Value,
) -> Result<Value, String> {
    let Some(observation) = current(page, obs) else {
        return Ok(reason("stale_ref"));
    };
    let Some(g) = observation.geometry else {
        return Ok(reason("vision_required"));
    };
    let coords: Vec<f64> = point
        .as_array()
        .map(|p| p.iter().filter_map(Value::as_f64).collect())
        .unwrap_or_default();
    let expect = expect.as_str().unwrap_or("");
    let ([px, py], false) = (
        coords.as_slice(),
        expect.trim().is_empty() || point.as_array().map_or(0, Vec::len) != 2,
    ) else {
        return Ok(reason("invalid_point"));
    };
    if *px < 0.0 || *py < 0.0 || *px >= g.width || *py >= g.height {
        return Ok(reason("point_outside_viewport"));
    }
    let css = (px * g.css_width / g.width, py * g.css_height / g.height);
    let main_url = observation
        .frames
        .first()
        .map_or_else(String::new, |f| f.url.clone());
    for index in (0..observation.frames.len()).rev() {
        let frame = &observation.frames[index];
        let Ok(origin) = page
            .frame_point(&observation.frames, index, (0.0, 0.0))
            .await
        else {
            continue;
        };
        let local = (css.0 - origin.0, css.1 - origin.1);
        if page
            .hit_frame(&observation.frames, index, local)
            .await?
            .is_none()
        {
            continue;
        }
        if frame.parent.is_some() && !same_origin(&frame.url, &main_url) {
            return Ok(reason("frame_not_granted"));
        }
        return framed_hit(page, &observation, index, (point, expect), css, origin).await;
    }
    Ok(point_refusal(
        &observation,
        point,
        expect,
        reason("blocked_by"),
        (0.0, 0.0),
    ))
}

/// The element that receives keyboard input now; the same frame rule as points.
pub(crate) async fn resolve_focus(
    page: &Page,
    obs: &Value,
    key: Option<&str>,
) -> Result<Value, String> {
    let Some(observation) = current(page, obs) else {
        return Ok(reason("stale_ref"));
    };
    let scripts = scripts().ok_or("page_scripts_unavailable")?;
    let main_url = observation
        .frames
        .first()
        .map_or_else(String::new, |f| f.url.clone());
    for (index, frame) in observation.frames.iter().enumerate() {
        let Ok(mut result) = page
            .evaluate(frame, &scripts.focus(&json!({"key":key})))
            .await
        else {
            continue;
        };
        if result.is_null() {
            continue;
        }
        if frame.parent.is_some() && !same_origin(&frame.url, &main_url) {
            return Ok(json!({"reason":"frame_not_granted","hit":result["hit"]}));
        }
        if !result["reason"].is_null() {
            return Ok(result);
        }
        result["keyboard"] = json!(true);
        result["payment"] = json!(result["payment"] == true || observation.payment);
        result["frame_payment"] =
            json!(frame.parent.is_some() && observation.payment_frames.contains(&index));
        result["addons"] = json!([]);
        return Ok(result);
    }
    let host = url::Url::parse(&main_url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_default();
    Ok(
        json!({"keyboard":true,"hit":{"role":"document","name":"","frame":host},"payment":false,"upload":false,"submit":false,"addons":[]}),
    )
}

pub(crate) async fn drag_target(
    page: &Page,
    obs: &Value,
    step: &Value,
    source: Value,
    scroll: bool,
) -> Result<Value, String> {
    let destination = if step["target_ref"].is_string() {
        resolve_step(page, obs, &json!({"ref":step["target_ref"]}), scroll).await?
    } else {
        let offset: Vec<f64> = step["offset"]
            .as_array()
            .map(|o| o.iter().filter_map(Value::as_f64).collect())
            .unwrap_or_default();
        if offset.len() != 2 || step["offset"].as_array().map_or(0, Vec::len) != 2 {
            return Ok(reason("invalid_drag"));
        }
        resolve_step(
            page,
            obs,
            &json!({"ref":step["ref"],"pointOffset":step["offset"]}),
            scroll,
        )
        .await?
    };
    if !destination["reason"].is_null() {
        return Ok(destination);
    }
    let mut out = source.clone();
    if step["target_ref"].is_string() {
        for key in ["payment", "frame_payment", "upload", "submit"] {
            out[key] = json!(source[key] == true || destination[key] == true);
        }
    }
    out["destination"] = destination;
    Ok(out)
}

pub(crate) async fn navigation_target(page: &Page, action: &str) -> Result<Value, String> {
    let history = page.send("Page.getNavigationHistory", json!({})).await?;
    let delta = match action {
        "back" => -1,
        "forward" => 1,
        _ => 0,
    };
    let entries = history["entries"].as_array().cloned().unwrap_or_default();
    let index = history["currentIndex"].as_i64().unwrap_or(0) + delta;
    let Some(entry) = usize::try_from(index).ok().and_then(|i| entries.get(i)) else {
        return Ok(reason("no_history"));
    };
    Ok(
        json!({"hit":{"role":"navigation","name":entry["url"],"frame":""},"payment":false,"upload":false,"submit":false,"frame_payment":false,"addons":[]}),
    )
}
