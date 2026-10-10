//! Batches of steps (the App executor's `act.mjs`): validated and resolved
//! before anything is dispatched, re-resolved and compared with the approved
//! target right before each dispatch, stopped at the first failure.
use super::{
    capture, input,
    js::{js_string, num},
    page::Page,
    steps::{self, NAVIGATION},
    validate::{STEP_HELP, present, step_error, wait_value},
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

fn neutral(role: &str) -> Value {
    json!({"hit":{"role":role,"name":"","frame":""},"payment":false,"upload":false,"submit":false,"frame_payment":false,"addons":[]})
}

async fn resolve_path(page: &Page, obs: &Value, step: &Value) -> Result<Value, String> {
    let mut path = Vec::new();
    for (index, point) in step["path"].as_array().into_iter().flatten().enumerate() {
        let mut hit = steps::resolve_point(page, obs, point, &step["expect"]).await?;
        if !hit["reason"].is_null() {
            hit["path_index"] = json!(index);
            if hit["recovery"].is_null() {
                hit["recovery"] = json!(
                    "Every path point must hit the same surface as the drag start. Replan the path inside the observed bounds. No steps were dispatched."
                );
            }
            return Ok(hit);
        }
        path.push(json!({"x":hit["x"],"y":hit["y"]}));
    }
    Ok(json!({"path":path}))
}

async fn resolve_action(
    page: &Page,
    args: &Value,
    step: &Value,
    scroll: bool,
    after_input: bool,
) -> Result<Value, String> {
    let action = step["action"].as_str().unwrap_or("");
    let obs = &args["observation"];
    if action == "wait" {
        return Ok(neutral("wait"));
    }
    if NAVIGATION.contains(&action) {
        return steps::navigation_target(page, action).await;
    }
    if matches!(action, "press" | "type") {
        let key = (action == "press")
            .then(|| input::parse_chord(&step["value"]).map(|c| c.key_code))
            .flatten();
        if after_input {
            let mut deferred = neutral("focus");
            deferred["keyboard"] = json!(true);
            deferred["deferred"] = json!(true);
            return Ok(deferred);
        }
        return steps::resolve_focus(page, obs, key.as_deref()).await;
    }
    let target = if present(&step["point"]) {
        steps::resolve_point(page, obs, &step["point"], &step["expect"]).await?
    } else {
        steps::resolve_step(page, obs, step, scroll).await?
    };
    if !target["reason"].is_null() {
        return Ok(target);
    }
    if action == "drag" && present(&step["target_point"]) {
        let expect = if step["target_expect"].is_null() {
            &step["expect"]
        } else {
            &step["target_expect"]
        };
        let destination = steps::resolve_point(page, obs, &step["target_point"], expect).await?;
        if !destination["reason"].is_null() {
            return Ok(destination);
        }
        let path = resolve_path(page, obs, step).await?;
        if !path["reason"].is_null() {
            return Ok(path);
        }
        let mut out = target.clone();
        for key in ["payment", "frame_payment", "upload", "submit"] {
            out[key] = json!(target[key] == true || destination[key] == true);
        }
        out["destination"] = destination;
        out["path"] = path["path"].clone();
        return Ok(out);
    }
    if action == "upload" {
        let mut out = target;
        out["upload"] = json!(true);
        return Ok(out);
    }
    if action == "drag" {
        return steps::drag_target(page, obs, step, target, scroll).await;
    }
    Ok(target)
}

/// Resolves every step without dispatching (for the approval card).
pub(crate) async fn prepare(page: &Page, args: &Value) -> Result<Value, String> {
    let count = args["steps"].as_array().map_or(0, Vec::len);
    if !(1..=10).contains(&count) {
        return Ok(
            json!({"status":"refused","reason":"invalid_steps","recovery":"Send 1–10 steps per call. No steps were dispatched."}),
        );
    }
    if let Some(resent) = page
        .shared
        .with_tab(&page.tab, |t| t.progress.resent_refusal(args))
        .flatten()
    {
        return Ok(resent);
    }
    let result = prepare_steps(page, args).await?;
    Ok(page
        .shared
        .with_tab(&page.tab, |t| {
            t.progress.remember_refusal(args, result.clone())
        })
        .unwrap_or(result))
}

async fn prepare_steps(page: &Page, args: &Value) -> Result<Value, String> {
    let list = args["steps"].as_array().cloned().unwrap_or_default();
    let observation = steps::current(page, &args["observation"]);
    let autocomplete = list.iter().take(list.len().saturating_sub(1)).any(|step| {
        step["action"] == "fill"
            && observation.as_ref().is_some_and(|o| {
                o.node(&js_string(&step["ref"])).is_some_and(|n| {
                    n["role"] == "combobox"
                        || matches!(n["autocomplete"].as_str(), Some("list" | "both"))
                })
            })
    });
    if autocomplete {
        return Ok(
            json!({"status":"refused","reason":"autocomplete_requires_observation","recovery":"An autocomplete fill must be the batch's last step: fill it (optionally after clicking it), observe its suggestions, select one, then continue. No steps were dispatched."}),
        );
    }
    let mut prepared = Vec::new();
    for (index, step) in list.iter().enumerate() {
        if let Some(error) = step_error(step) {
            return Ok(
                json!({"status":"refused","reason":error,"step_index":index,"action":step["action"],"recovery":STEP_HELP}),
            );
        }
        let action = step["action"].as_str().unwrap_or("");
        if NAVIGATION.contains(&action) && index != list.len() - 1 {
            return Ok(
                json!({"status":"refused","reason":"navigation_not_last","step_index":index,"action":action,"recovery":"back, forward and reload replace the page: send them as the batch's last step. No steps were dispatched."}),
            );
        }
        let after_input = list[..index].iter().any(|s| s["action"] != "wait");
        let mut target = resolve_action(page, args, step, false, after_input).await?;
        if !target["reason"].is_null() {
            let mut refusal =
                json!({"status":"refused","step_index":prepared.len(),"action":action});
            if let (Some(out), Some(target)) = (refusal.as_object_mut(), target.as_object()) {
                out.extend(target.clone());
            }
            return Ok(refusal);
        }
        let value = if action == "upload" {
            json!(
                js_string(&step["value"])
                    .rsplit(['/', '\\'])
                    .next()
                    .unwrap_or("")
            )
        } else {
            step["value"].clone()
        };
        target["action"] = json!(action);
        if let Some(text) = value.as_str() {
            target["value_preview"] = json!(text.chars().take(40).collect::<String>());
        }
        prepared.push(target);
    }
    if let Some(repeat) = page
        .shared
        .with_tab(&page.tab, |t| t.progress.repeat_refusal(args, &prepared))
        .flatten()
    {
        return Ok(repeat);
    }
    let (epoch, url) = page
        .shared
        .with_tab(&page.tab, |t| (t.epoch, t.url.clone()))
        .unwrap_or_default();
    Ok(
        json!({"status":"ok","tab":page.tab,"epoch":epoch,"obs":args["observation"],"url":url,"steps":prepared}),
    )
}

fn sensitive(target: &Value) -> bool {
    target["payment"] == true && target["submit"] == true
        || target["upload"] == true
        || target["frame_payment"] == true
}

fn same_target(prepared: &Value, current: &Value) -> bool {
    if prepared["deferred"] == true {
        return !sensitive(current);
    }
    !prepared.is_null()
        && [
            "hit",
            "destination",
            "frame_payment",
            "payment",
            "upload",
            "submit",
            "addons",
        ]
        .iter()
        .all(|key| {
            prepared.get(*key).unwrap_or(&Value::Null) == current.get(*key).unwrap_or(&Value::Null)
        })
}

async fn dispatch(
    page: &Page,
    args: &Value,
    step: &Value,
    target: &Value,
    epoch: u64,
) -> Result<Value, String> {
    let action = step["action"].as_str().unwrap_or("");
    let done = || json!({"status":"completed","hit":target["hit"]});
    match action {
        "wait" => {
            let ms = wait_value(&step["value"])
                .unwrap_or(50.0)
                .clamp(50.0, 5000.0);
            tokio::time::sleep(Duration::from_secs_f64(ms / 1000.0)).await;
            return Ok(done());
        }
        "press" => {
            let chord = input::parse_chord(&step["value"]).ok_or("invalid_key")?;
            input::press(page, &chord).await?;
            tokio::task::yield_now().await;
            return Ok(done());
        }
        "type" => {
            input::insert_text(page, step["value"].as_str().unwrap_or("")).await?;
            return Ok(done());
        }
        _ if NAVIGATION.contains(&action) => {
            input::navigate_history(page, action).await?;
            return Ok(done());
        }
        "drag" => return Ok(input::drag(page, target, step, epoch).await),
        _ => {}
    }
    let (x, y) = (
        super::js::round(num(&target["x"], 0.0)),
        super::js::round(num(&target["y"], 0.0)),
    );
    if action == "select" {
        let scripts = super::scripts::scripts().ok_or("page_scripts_unavailable")?;
        let observation = steps::current(page, &args["observation"]).ok_or("stale_ref")?;
        let frame = observation
            .frame_of(&js_string(&step["ref"]))
            .ok_or("stale_ref")?;
        let input = json!({"ref":step["ref"],"obs":args["observation"],"epoch":observation.epoch,"value":step["value"]});
        return page.evaluate(frame, &scripts.select(&input)).await;
    }
    input::move_to(page, x, y).await?;
    if action == "upload" {
        let mut result = input::upload(page, x, y, step).await;
        result["hit"] = target["hit"].clone();
        return Ok(result);
    }
    if action == "scroll" {
        input::wheel(page, x, y, step).await?;
    }
    if matches!(action, "click" | "fill") {
        input::click(page, x, y, step).await?;
    }
    if action == "fill" {
        select_text(page, args, step).await?;
        input::insert_text(page, &js_string(&step["value"])).await?;
    }
    tokio::task::yield_now().await;
    Ok(done())
}

async fn select_text(page: &Page, args: &Value, step: &Value) -> Result<(), String> {
    let observation = steps::current(page, &args["observation"]).ok_or("stale_ref")?;
    let frame = observation
        .frame_of(&js_string(&step["ref"]))
        .ok_or("stale_ref")?;
    let code = format!(
        "(async()=>{{await new Promise(done=>requestAnimationFrame(done));const e=globalThis.__butlerObservation.refs.get({}).deref();if(e.isContentEditable){{const range=document.createRange();range.selectNodeContents(e);const selection=getSelection();selection.removeAllRanges();selection.addRange(range)}}else e.select()}})()",
        step["ref"]
    );
    page.evaluate(frame, &code).await.map(|_| ())
}

fn recovery(reason: &str, first: usize) -> String {
    match reason {
        "control_changed" => "The page navigated or re-rendered after the completed steps, so the observation expired. Completed steps took effect; never repeat them. Observe and continue with the remaining steps using fresh refs or points.".to_owned(),
        "approval_target_changed" => "An earlier step changed this step's target (focus or element moved, or it became sensitive). Completed steps took effect; never repeat them. Observe and send the remaining steps again; a keyboard step into a payment or upload control needs its own call.".to_owned(),
        "stale_ref" => "The observation expired after the completed steps. Completed steps took effect; never repeat them. Observe and continue with fresh refs.".to_owned(),
        other => format!("Step {first} was not dispatched ({other}). Completed steps took effect; never repeat them. Observe before continuing."),
    }
}

fn batch_result(page: &Page, steps: &[Value], failed: bool) -> Value {
    let completed = steps.iter().filter(|s| s["status"] == "completed").count();
    let notes: Vec<Value> = steps
        .iter()
        .enumerate()
        .filter_map(|(i, s)| {
            s["canvas_effect"]["note"]
                .as_str()
                .map(|n| json!(format!("Step {i}: {n}")))
        })
        .collect();
    let status = if steps.iter().any(|s| s["status"] == "unknown") {
        "unknown"
    } else if failed {
        "interrupted"
    } else {
        "ok"
    };
    let (epoch, url) = page
        .shared
        .with_tab(&page.tab, |t| (t.epoch, t.url.clone()))
        .unwrap_or_default();
    let mut result = serde_json::Map::new();
    if !notes.is_empty() {
        result.insert("notes".into(), json!(notes));
    }
    let first = steps.iter().position(|s| s["status"] != "completed");
    let body = json!({"status":status,"tab":page.tab,"steps":steps,"url":url,"epoch":epoch,"completed":completed});
    result.extend(body.as_object().cloned().unwrap_or_default());
    if let (Some(first), "interrupted") = (first, status) {
        let reason = js_string(&result["steps"][first]["reason"]);
        result.insert("next_step_index".into(), json!(first));
        result.insert("recovery".into(), json!(recovery(&reason, first)));
    }
    Value::Object(result)
}

fn fenced(page: &Page, epoch: u64, deadline: Instant) -> bool {
    Instant::now() >= deadline
        || page
            .shared
            .with_tab(&page.tab, |t| t.cancelled || t.epoch != epoch)
            .unwrap_or(true)
}

/// Dispatches an approved batch: each step re-resolved, compared with its
/// approved target, then sent as trusted input.
pub(crate) async fn act(page: &Page, args: &Value, deadline_ms: u64) -> Result<Value, String> {
    let epoch = page.epoch().ok_or("tab_closed")?;
    let deadline = Instant::now() + Duration::from_millis(deadline_ms.min(30_000));
    let list = args["steps"].as_array().cloned().unwrap_or_default();
    let mut results: Vec<Value> = Vec::new();
    let mut failed = false;
    for (index, step) in list.iter().enumerate() {
        if failed || fenced(page, epoch, deadline) {
            results.push(json!({"status":"not_dispatched","reason":if failed {"previous_step_failed"} else {"control_changed"}}));
            failed = true;
            continue;
        }
        let outcome = run_step(
            page,
            args,
            step,
            &args["prepared_steps"][index],
            epoch,
            deadline,
        )
        .await;
        let (result, stop) = outcome.unwrap_or_else(|_| {
            (
                json!({"status":"unknown","reason":"dispatch_interrupted"}),
                true,
            )
        });
        failed |= stop;
        results.push(result);
    }
    page.shared
        .with_tab(&page.tab, |t| t.progress.record_batch(args, &results));
    let pending = page
        .shared
        .with_tab(&page.tab, |t| {
            t.dialog.is_some().then(|| {
                t.pending_batch = Some(results.clone());
                t.pending_dialog()
            })
        })
        .flatten();
    if let Some(mut pending) = pending {
        pending["steps"] = json!(results);
        return Ok(pending);
    }
    Ok(batch_result(page, &results, failed))
}

/// One step's receipt, and whether the batch stops after it.
async fn run_step(
    page: &Page,
    args: &Value,
    step: &Value,
    prepared: &Value,
    epoch: u64,
    deadline: Instant,
) -> Result<(Value, bool), String> {
    let target = if prepared["deferred"] == true {
        let key = (step["action"] == "press")
            .then(|| input::parse_chord(&step["value"]).map(|c| c.key_code))
            .flatten();
        steps::resolve_focus(page, &args["observation"], key.as_deref()).await?
    } else {
        resolve_action(page, args, step, true, false).await?
    };
    if !target["reason"].is_null() {
        let mut out = json!({"status":"not_dispatched"});
        if let (Some(o), Some(t)) = (out.as_object_mut(), target.as_object()) {
            o.extend(t.clone());
        }
        return Ok((out, true));
    }
    if !same_target(prepared, &target) {
        return Ok((
            json!({"status":"not_dispatched","reason":"approval_target_changed"}),
            true,
        ));
    }
    if fenced(page, epoch, deadline) {
        return Ok((
            json!({"status":"not_dispatched","reason":"control_changed"}),
            true,
        ));
    }
    let before = if step["action"] == "drag" {
        capture::canvas_before(page, &target).await
    } else {
        None
    };
    let mut result = dispatch(page, args, step, &target, epoch).await?;
    if let Some(before) = before
        && result["status"] == "completed"
        && let Some(effect) = capture::canvas_effect(page, &before, &target).await
    {
        result["canvas_effect"] = effect;
    }
    let pending = json!({"status":"unknown","reason":"dialog_pending","hit":target["hit"]});
    if page.has_dialog() {
        return Ok((pending, true));
    }
    if result["status"] == "completed"
        && page.epoch() == Some(epoch)
        && let Some(still) = capture::still(page).await
    {
        result["still"] = still;
        if page.has_dialog() {
            return Ok((pending, true));
        }
    }
    Ok((result, false))
}
