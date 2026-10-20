//! The pending receipt is committed before any click can reach the host.
use super::{HttpError, HttpState};
use crate::gateway::AppBrowserStillCommand as C;
use serde_json::{Value, json};

pub(super) async fn reserve(state: &HttpState, id: &str, frame: &Value) -> Result<(), HttpError> {
    state
        .application
        .browser_still(C::Reserve {
            id: id.into(),
            session: frame["session"].as_str().unwrap_or_default().into(),
            tab: frame["tab"].as_str().unwrap_or_default().into(),
            count: frame["args"]["steps"].as_array().map_or(0, Vec::len),
        })
        .await?;
    Ok(())
}
pub(super) async fn finish(
    state: &HttpState,
    id: &str,
    session: &str,
    result: &mut Value,
    awaiting_host: bool,
) -> Result<(), HttpError> {
    let steps = result["steps"].as_array();
    let awaiting = if awaiting_host {
        (0..10).collect()
    } else {
        steps
            .map(|steps| {
                steps
                    .iter()
                    .enumerate()
                    .filter_map(|(i, step)| (step["status"] == "completed").then_some(i))
                    .collect()
            })
            .unwrap_or_default()
    };
    let failures = (0..10)
        .map(|index| {
            let reason = steps
                .and_then(|steps| steps.get(index))
                .and_then(|step| step["reason"].as_str())
                .or_else(|| result["reason"].as_str())
                .unwrap_or("pixels_not_captured");
            (index, reason.to_owned())
        })
        .collect();
    state
        .application
        .browser_still(C::Finish {
            id: id.into(),
            session: session.into(),
            awaiting,
            failures,
        })
        .await?;
    result["still_pending"] = json!({"id":id,"session":session});
    state.browser.4.notify_waiters();
    Ok(())
}
pub(super) async fn upload(state: &HttpState, value: &Value) -> Result<Value, HttpError> {
    use base64::Engine;
    let id = value["act_id"]
        .as_str()
        .filter(|s| uuid::Uuid::parse_str(s).is_ok())
        .ok_or_else(|| super::error(400, "invalid_act"))?
        .to_owned();
    let session = value["session"].as_str().unwrap_or_default().to_owned();
    let step = value["step"]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .filter(|n| *n < 10)
        .ok_or_else(|| super::error(400, "invalid_step"))?;
    let command = if let Some(reason) = value["reason"].as_str().filter(|r| r.len() <= 128) {
        C::Fail {
            id,
            session,
            step,
            reason: reason.into(),
        }
    } else {
        let raw = value["still"]["base64"]
            .as_str()
            .filter(|s| s.len() <= 32768)
            .ok_or_else(|| super::error(400, "invalid_still"))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(raw)
            .map_err(|_| super::error(400, "invalid_still"))?;
        C::Attach {
            id,
            session,
            step,
            tab: value["tab"].as_str().unwrap_or_default().into(),
            bytes: bytes.into(),
        }
    };
    let _exclusive = state.browser.1.lock().await;
    let result = state.application.browser_still(command).await?;
    state.browser.4.notify_waiters();
    Ok(result)
}
