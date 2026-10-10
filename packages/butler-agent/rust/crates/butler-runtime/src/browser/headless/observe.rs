//! Layer 1 observation of a headless tab (the App executor's `observe.mjs`),
//! with the same page scripts, budgets, progress notes and result shape.
use super::{
    capture,
    js::{jnum, js_string, num, round},
    layout::content_regions,
    page::Page,
    progress::Current,
    scripts::scripts,
    state::{Frame, Geometry, Observation},
};
use serde_json::{Map, Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

/// Retries an observation that a load-time navigation interrupted.
pub(crate) async fn observe(page: &Page, args: &Value) -> Result<Value, String> {
    if args["settle"] == true {
        super::settle::settle(page, Duration::from_secs(5)).await;
    }
    let mut attempt = 0;
    loop {
        let result = observe_once(page, args).await?;
        if result["reason"] != "page_changed" || attempt == 2 {
            return Ok(result);
        }
        attempt += 1;
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

fn changed() -> Value {
    json!({"status":"not_dispatched","reason":"page_changed","recovery":"The page navigated while it was observed. Observe again; no action was taken."})
}

fn budget(args: &Value, interactive: u64, below: u64) -> Value {
    let recovery = if args["scope"] == "text" {
        "Observe one returned frame at a time. No complete observation was returned; do not act or capture with an older observation."
    } else {
        "Observe again with scope=\"text\" to retain the complete controls and screenshot within the existing text budget. Inspect any open dialog and close it by its fresh ref before drawing or capturing. Do not reuse the older observation."
    };
    json!({"status":"refused","reason":"observation_budget_exceeded","totals":{"interactive":interactive,"below_fold":below},"recovery":recovery})
}

fn editable(nodes: &[Value]) -> Vec<Value> {
    let mut fields: Vec<Value> = nodes
        .iter()
        .filter(|n| n["secure"] != true && n.get("value").is_some_and(|v| !v.is_null()))
        .cloned()
        .collect();
    fields.sort_by(|a, b| {
        let key = |n: &Value| (num(&n["rect"]["y"], 0.0), num(&n["rect"]["x"], 0.0));
        key(a)
            .partial_cmp(&key(b))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    fields
}

fn field_text(fields: &[Value]) -> String {
    if fields.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = fields
        .iter()
        .enumerate()
        .map(|(i, n)| {
            let covered = n["coveredBy"]
                .as_str()
                .map_or_else(String::new, |c| format!(" covered_by {c}"));
            let not = if n["actionable"] == true {
                ""
            } else {
                " not actionable"
            };
            format!(
                "{}. {} {} [{}] value={}{covered}{not}",
                i + 1,
                js_string(&n["role"]),
                n["name"],
                js_string(&n["ref"]),
                n["value"]
            )
        })
        .collect();
    format!(
        "Visible editable fields, top to bottom ({}):\n{}",
        fields.len(),
        lines.join("\n")
    )
}

#[derive(Default)]
struct Gathered {
    text: Vec<String>,
    nodes: Vec<Value>,
    fields: Vec<Value>,
    regions: Vec<Value>,
    hidden: [u64; 3],
    bindings: HashMap<String, usize>,
    payment_frames: HashSet<usize>,
    script_ms: f64,
    grid_ms: f64,
    below: u64,
    interactive: u64,
    payment: bool,
    addons: Vec<Value>,
}

async fn gather(
    page: &Page,
    frames: &[Frame],
    selected: &[usize],
    options: &Value,
    out: &mut Gathered,
) -> Result<(), String> {
    let scripts = scripts().ok_or("page_scripts_unavailable")?;
    for &index in selected {
        let frame = &frames[index];
        let mut opts = options.clone();
        opts["prefix"] = json!(format!("f{index}-"));
        let mut result = page.evaluate(frame, &scripts.perception(&opts)).await?;
        super::names::name_observation(page, frame, &mut result).await;
        if result["layout_regions"]
            .as_array()
            .is_some_and(|r| !r.is_empty())
        {
            let origin = page.frame_point(frames, index, (0.0, 0.0)).await?;
            for region in result["layout_regions"].as_array().into_iter().flatten() {
                let mut region = region.clone();
                region["frame"] = json!(format!("f{index}"));
                region["rect"]["x"] = jnum(num(&region["rect"]["x"], 0.0) + origin.0);
                region["rect"]["y"] = jnum(num(&region["rect"]["y"], 0.0) + origin.1);
                out.regions.push(region);
            }
        }
        let nodes = result["nodes"].as_array().cloned().unwrap_or_default();
        for node in &nodes {
            out.bindings.insert(js_string(&node["ref"]), index);
            let mut public = node.clone();
            if let Some(map) = public.as_object_mut() {
                map.remove("targetId");
                map.remove("coveredTargetId");
            }
            out.nodes.push(public);
        }
        if result["payment"] == true {
            out.payment_frames.insert(index);
        }
        let inputs = editable(&nodes);
        for (position, node) in inputs.iter().enumerate() {
            let mut field = json!({"ref":node["ref"],"frame":format!("f{index}"),"position":position + 1,"role":node["role"],
                "name":node["name"],"value":node["value"],"actionable":node["actionable"]});
            if !node["coveredBy"].is_null() {
                field["covered_by"] = node["coveredBy"].clone();
            }
            out.fields.push(field);
        }
        let text: Vec<String> = [field_text(&inputs), js_string(&result["text"])]
            .into_iter()
            .filter(|t| !t.is_empty())
            .collect();
        out.text.push(text.join("\n"));
        for (slot, key) in ["invisible", "low_contrast", "tiny"].iter().enumerate() {
            out.hidden[slot] += result["hidden"][key].as_u64().unwrap_or(0);
        }
        out.script_ms += num(&result["scriptMs"], 0.0);
        out.grid_ms += num(&result["gridSampleMs"], 0.0);
        out.below += result["totals"]["below_fold"].as_u64().unwrap_or(0);
        out.interactive += result["totals"]["interactive"].as_u64().unwrap_or(0);
        out.payment |= result["payment"] == true;
        out.addons
            .extend(result["addons"].as_array().cloned().unwrap_or_default());
    }
    Ok(())
}

/// The text half of an observation, before any image.
struct Collected {
    id: String,
    obs: String,
    epoch: u64,
    frames: Vec<Frame>,
    selected: Vec<usize>,
    g: Gathered,
    hidden: Value,
    full: String,
    max: usize,
}

async fn collect(page: &Page, args: &Value) -> Result<Result<Collected, Value>, String> {
    let (id, obs, epoch, policy) = page
        .shared
        .with_tab(&page.tab, |t| {
            t.observation_seq += 1;
            (
                t.id.clone(),
                format!("o{}", t.observation_seq),
                t.epoch,
                t.policy.clone(),
            )
        })
        .ok_or("tab_closed")?;
    let frames = page.frame_worlds().await?;
    let selected: Vec<usize> = (0..frames.len())
        .filter(|i| args["frame"].is_null() || args["frame"] == format!("f{i}").as_str())
        .collect();
    if selected.is_empty() {
        return Ok(Err(
            json!({"status":"refused","reason":"frame_unavailable"}),
        ));
    }
    let keypads = policy
        .get("secure_keypads")
        .or_else(|| args["policy"].get("secure_keypads"))
        .cloned()
        .unwrap_or_else(|| json!([]));
    let options = json!({"obs":obs,"epoch":epoch,"scope":args["scope"],"secureKeypads":keypads});
    let mut g = Gathered::default();
    gather(page, &frames, &selected, &options, &mut g).await?;
    if page.epoch() != Some(epoch) {
        return Ok(Err(changed()));
    }
    let hidden = json!({"invisible":g.hidden[0],"low_contrast":g.hidden[1],"tiny":g.hidden[2]});
    let full = format!(
        "tab {id} epoch {epoch} obs {obs}\nNode rects and icon positions are CSS coordinates. Pointer points and capture_regions use screenshot coordinates; use image_geometry to convert.\n{}\ninteractive {}/{} · below fold {} · hidden {}",
        g.text.join("\n"),
        g.interactive,
        g.interactive,
        g.below,
        hidden
    );
    let max = if args["scope"] == "text" {
        32000
    } else {
        16000
    };
    if full.len() > max {
        return Ok(Err(budget(args, g.interactive, g.below)));
    }
    Ok(Ok(Collected {
        id,
        obs,
        epoch,
        frames,
        selected,
        g,
        hidden,
        full,
        max,
    }))
}

async fn observe_once(page: &Page, args: &Value) -> Result<Value, String> {
    let Collected {
        id,
        obs,
        epoch,
        frames,
        selected,
        g,
        hidden,
        full,
        max,
    } = match collect(page, args).await? {
        Ok(collected) => collected,
        Err(refusal) => return Ok(refusal),
    };
    let url = page
        .shared
        .with_tab(&page.tab, |t| t.url.clone())
        .unwrap_or_default();
    let mut observation = Observation {
        obs: obs.clone(),
        epoch,
        frames: frames.clone(),
        bindings: g.bindings.clone(),
        nodes: g.nodes.clone(),
        fields: g.fields.clone(),
        payment: g.payment,
        payment_frames: g.payment_frames.clone(),
        complete: selected.len() == frames.len(),
        geometry: None,
        capture_regions: json!([]),
        thumb: None,
    };
    let image = match image_step(page, args, &mut observation).await {
        Ok(image) => image,
        Err(refusal) => {
            store(page, observation);
            return Ok(refusal);
        }
    };
    let progress = page
        .shared
        .with_tab(&page.tab, |t| {
            t.progress.note(Current {
                obs: &obs,
                url: &url,
                nodes: &g.nodes,
                fields: &g.fields,
                thumb: observation.thumb.clone(),
            })
        })
        .flatten();
    let points = graphical_points(page, &observation).await?;
    let observed = [full, points]
        .into_iter()
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if page.epoch() != Some(epoch) {
        return Ok(changed());
    }
    if observed.len() > max {
        return Ok(budget(args, g.interactive, g.below));
    }
    observation.capture_regions = content_regions(&g.regions, observation.geometry);
    let geometry = observation.geometry.map(Geometry::to_value);
    let regions = observation.capture_regions.clone();
    store(page, observation);
    let parts = Parts {
        progress,
        image,
        geometry,
        regions,
        hidden,
        observed,
        url,
    };
    Ok(assemble(&id, &obs, epoch, &frames, &selected, &g, parts))
}

fn store(page: &Page, observation: Observation) {
    page.shared
        .with_tab(&page.tab, |t| t.observation = Some(Arc::new(observation)));
}

#[expect(
    clippy::many_single_char_names,
    reason = "geometry names mirror the App executor"
)]
async fn graphical_points(page: &Page, observation: &Observation) -> Result<String, String> {
    let Some(g) = observation.geometry else {
        return Ok(String::new());
    };
    let icons: Vec<&Value> = observation
        .nodes
        .iter()
        .filter(|n| n["actionable"] == true && super::names::is_geometric(&js_string(&n["name"])))
        .collect();
    if icons.is_empty() {
        return Ok(String::new());
    }
    let mut origins = HashMap::new();
    for node in &icons {
        let index = observation
            .bindings
            .get(&js_string(&node["ref"]))
            .copied()
            .unwrap_or(0);
        if let std::collections::hash_map::Entry::Vacant(slot) = origins.entry(index) {
            slot.insert(
                page.frame_point(&observation.frames, index, (0.0, 0.0))
                    .await?,
            );
        }
    }
    let (sx, sy) = (g.width / g.css_width, g.height / g.css_height);
    let lines: Vec<String> = icons
        .iter()
        .map(|node| {
            let index = observation.bindings.get(&js_string(&node["ref"])).copied().unwrap_or(0);
            let o = origins.get(&index).copied().unwrap_or((0.0, 0.0));
            let r = &node["rect"];
            let (x, y, w, h) = (num(&r["x"], 0.0), num(&r["y"], 0.0), num(&r["width"], 0.0), num(&r["height"], 0.0));
            let cx = round((o.0 + x + w / 2.0) * sx);
            let cy = round((o.1 + y + h / 2.0) * sy);
            let (left, top) = (((o.0 + x) * sx).ceil(), ((o.1 + y) * sy).ceil());
            let (right, bottom) = (((o.0 + x + w) * sx).floor(), ((o.1 + y + h) * sy).floor());
            let canvas = node["role"] == "canvas";
            let bounds = if canvas {
                format!(" canvas screenshot bounds=[{left},{top},{},{}] (x,y,width,height); drag endpoints require {left}<=x<{right}, {top}<=y<{bottom}", right - left, bottom - top)
            } else {
                String::new()
            };
            let expect = if canvas { "canvas".to_owned() } else { format!("{} icon", js_string(&node["role"])) };
            format!("[{}] center=[{cx},{cy}] expect={}{bounds}", js_string(&node["ref"]), Value::String(expect))
        })
        .collect();
    Ok(format!(
        "Graphical targets in screenshot coordinates (ref or point, never both):\n{}",
        lines.join("\n")
    ))
}

/// The image-side parts of an observation result.
struct Parts {
    progress: Option<Value>,
    image: Map<String, Value>,
    geometry: Option<Value>,
    regions: Value,
    hidden: Value,
    observed: String,
    url: String,
}

/// The App executor's observation result; progress notes lead it.
fn assemble(
    id: &str,
    obs: &str,
    epoch: u64,
    frames: &[Frame],
    selected: &[usize],
    g: &Gathered,
    parts: Parts,
) -> Value {
    let Parts {
        progress,
        image,
        geometry,
        regions,
        hidden,
        observed,
        url,
    } = parts;
    let mut result = Map::new();
    if let Some(progress) = progress {
        result.insert("progress".into(), progress);
    }
    let body = json!({"status":"ok","tab":id,"obs":obs,"epoch":epoch,"url":url,
        "frames":selected.iter().map(|i| json!({"id":format!("f{i}"),"url":frames[*i].url})).collect::<Vec<_>>(),
        "text":observed,"nodes":g.nodes,"fields":g.fields,"layout_regions":g.regions,"capture_regions":regions,
        "hidden":hidden,"totals":{"interactive":g.interactive,"below_fold":g.below},"cursor":null,
        "scriptMs":g.script_ms,"gridSampleMs":g.grid_ms,"payment":g.payment,"addons":g.addons});
    result.extend(body.as_object().cloned().unwrap_or_default());
    if let Some(geometry) = geometry {
        result.insert("image_geometry".into(), geometry);
    }
    result.extend(image);
    Value::Object(result)
}

/// The marked screenshot when asked for; without it the observation still
/// replaces every earlier one, and the refusal says so.
async fn image_step(
    page: &Page,
    args: &Value,
    observation: &mut Observation,
) -> Result<Map<String, Value>, Value> {
    if args["include_image"] != true {
        return Ok(Map::new());
    }
    let image = capture::observation_image(page, observation).await;
    if image.get("image").is_some() {
        return Ok(image);
    }
    let obs = observation.obs.clone();
    Err(
        json!({"status":"refused","reason":image.get("image_status").cloned().unwrap_or_else(|| json!("image_unavailable")),"obs":obs,
        "recovery":format!("The page was observed as {obs}, which replaced every earlier observation id, but no screenshot could be made. Observe again; look \"never\" returns a text-only observation.")}),
    )
}
