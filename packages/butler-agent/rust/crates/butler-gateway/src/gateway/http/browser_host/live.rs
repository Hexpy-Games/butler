use super::{HttpError, HttpState, PendingCall, error};
use axum::{
    body::{Body, Bytes},
    http::{Method, Request, StatusCode},
    response::Response,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot, watch};
use uuid::{Uuid, Variant};

const START_TIMEOUT: Duration = Duration::from_secs(5);
const UPLOAD_PREFIX: &str = "/internal/browser-host/live/";

#[derive(Default)]
pub(in crate::gateway::http) struct Feeds(Mutex<FeedMap>);

#[derive(Default)]
struct FeedMap {
    by_sub: HashMap<String, Arc<Feed>>,
    by_tab: HashMap<String, String>,
    viewers: HashMap<String, usize>,
}

pub(super) struct Feed {
    sub: String,
    pub(super) tab: String,
    session: String,
    pub(super) generation: u64,
    pub(super) frame: watch::Sender<Option<Arc<Frame>>>,
    started: watch::Sender<Option<bool>>,
    inputs: Mutex<HashMap<Uuid, u64>>,
}

pub(super) struct Frame {
    pub(super) seq: u64,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) jpeg: Bytes,
}

pub(super) struct Viewer {
    state: Arc<HttpState>,
    pub(super) feed: Arc<Feed>,
}

impl Drop for Viewer {
    fn drop(&mut self) {
        let (Ok(hub), Ok(mut map)) = (self.state.browser.0.lock(), self.state.browser.6.0.lock())
        else {
            return;
        };
        let Some(count) = map.viewers.get_mut(&self.feed.sub) else {
            return;
        };
        *count -= 1;
        if *count != 0 {
            return;
        }
        map.viewers.remove(&self.feed.sub);
        map.by_sub.remove(&self.feed.sub);
        map.by_tab.remove(&self.feed.tab);
        if hub.generation == self.feed.generation
            && let Some(host) = &hub.host
        {
            let _ = host.try_send(json!({
                "id": Uuid::new_v4().to_string(), "op": "live.stop", "session": self.feed.session,
                "tab": self.feed.tab, "args": {"sub": self.feed.sub}
            }));
        }
    }
}

pub(super) async fn attach(
    state: &Arc<HttpState>,
    tab: &str,
    session: &str,
    mut args: Value,
) -> Result<Viewer, HttpError> {
    let unavailable = || error(409, "live_unavailable");
    let (viewer, start) = {
        let mut hub = state.browser.0.lock().map_err(|_| HttpError::Internal)?;
        if !hub.tabs.is_user(tab)
            || !hub
                .tabs
                .get(tab)
                .is_some_and(|t| t["owner"] == format!("conversation:{session}"))
        {
            return Err(error(409, "no_hand_off"));
        }
        let mut map = state.browser.6.0.lock().map_err(|_| HttpError::Internal)?;
        let existing = map.by_tab.get(tab).and_then(|sub| map.by_sub.get(sub));
        let (feed, start) = if let Some(feed) = existing.cloned() {
            if feed.generation != hub.generation || feed.session != session {
                return Err(unavailable());
            }
            (feed, None)
        } else {
            let host = hub.host.as_ref().ok_or_else(unavailable)?;
            let sub = Uuid::new_v4().to_string();
            let id = Uuid::new_v4().to_string();
            let (sender, receiver) = oneshot::channel();
            args["sub"] = json!(sub);
            host.try_send(json!({
                "id": id, "op": "live.start", "session": session, "tab": tab, "args": args
            }))
            .map_err(|_| unavailable())?;
            hub.pending.insert(id.clone(), sender.into());
            let feed = Arc::new(Feed {
                sub: sub.clone(),
                tab: tab.to_owned(),
                session: session.to_owned(),
                generation: hub.generation,
                frame: watch::Sender::new(None),
                started: watch::Sender::new(None),
                inputs: Mutex::default(),
            });
            map.by_tab.insert(tab.to_owned(), sub.clone());
            map.by_sub.insert(sub, feed.clone());
            (feed, Some((id, receiver)))
        };
        *map.viewers.entry(feed.sub.clone()).or_default() += 1;
        let viewer = Viewer {
            state: state.clone(),
            feed,
        };
        (viewer, start)
    };
    let started = if let Some((id, receiver)) = start {
        let _pending = PendingCall {
            state: state.clone(),
            id,
        };
        let ok = matches!(
            tokio::time::timeout(START_TIMEOUT, receiver).await,
            Ok(Ok(reply)) if reply["status"] == "ok"
        );
        viewer.feed.started.send_replace(Some(ok));
        ok
    } else {
        let mut started = viewer.feed.started.subscribe();
        matches!(
            tokio::time::timeout(START_TIMEOUT, started.wait_for(Option::is_some)).await,
            Ok(Ok(outcome)) if *outcome == Some(true)
        )
    };
    if started {
        Ok(viewer)
    } else {
        Err(unavailable())
    }
}

pub(super) async fn upload(
    state: &HttpState,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let Some(sub) = request
        .uri()
        .path()
        .strip_prefix(UPLOAD_PREFIX)
        .filter(|sub| !sub.is_empty() && !sub.contains('/') && request.method() == Method::POST)
        .map(str::to_owned)
    else {
        return Err(error(404, "not_found"));
    };
    let invalid = || error(400, "invalid_frame");
    let bytes = super::super::read_body_with_limit(request.into_body(), 2 * 1024 * 1024).await?;
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let dimension = |key| {
        body[key]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .filter(|&n| n > 0)
    };
    let width = dimension("width").ok_or_else(invalid)?;
    let height = dimension("height").ok_or_else(invalid)?;
    let jpeg = STANDARD
        .decode(body["jpeg"].as_str().ok_or_else(invalid)?)
        .map_err(|_| invalid())?;
    if jpeg.len() > 1_572_864 || !jpeg.starts_with(&[0xff, 0xd8]) {
        return Err(invalid());
    }
    let map = state.browser.6.0.lock().map_err(|_| HttpError::Internal)?;
    let feed = map
        .by_sub
        .get(&sub)
        .ok_or_else(|| error(404, "live_ended"))?;
    feed.frame.send_modify(|slot| {
        let seq = slot.as_ref().map_or(1, |prev| prev.seq + 1);
        *slot = Some(Arc::new(Frame {
            seq,
            width,
            height,
            jpeg: jpeg.into(),
        }));
    });
    super::super::json(StatusCode::OK, json!({"ok": true}))
}

pub(super) async fn input(
    state: &Arc<HttpState>,
    tab: &str,
    body: &Value,
) -> Result<Value, HttpError> {
    let (client, seq, events) = validate_events(body).ok_or_else(|| error(400, "invalid_input"))?;
    let applied = json!({"seq": seq, "applied": true});
    let (id, receiver) = {
        let mut hub = state.browser.0.lock().map_err(|_| HttpError::Internal)?;
        if !hub.tabs.is_user(tab) {
            return Err(error(409, "live_not_held"));
        }
        let map = state.browser.6.0.lock().map_err(|_| HttpError::Internal)?;
        let feed = map
            .by_tab
            .get(tab)
            .and_then(|sub| map.by_sub.get(sub))
            .ok_or_else(|| error(409, "live_not_open"))?;
        if feed.generation != hub.generation {
            return Err(error(409, "live_not_held"));
        }
        let mut inputs = feed.inputs.lock().map_err(|_| HttpError::Internal)?;
        if let Some(last) = inputs.get(&client) {
            if seq <= *last {
                return Ok(applied);
            }
        } else if inputs.len() == 16 {
            return Err(error(429, "browser_busy"));
        }
        let host = hub
            .host
            .as_ref()
            .ok_or_else(|| error(409, "live_not_held"))?;
        let slot = host.try_reserve().map_err(|e| match e {
            mpsc::error::TrySendError::Full(()) => error(429, "browser_busy"),
            mpsc::error::TrySendError::Closed(()) => error(409, "live_not_held"),
        })?;
        let id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        inputs.insert(client, seq);
        slot.send(json!({
            "id": id, "op": "live.input", "session": feed.session, "tab": tab,
            "args": {"sub": feed.sub, "events": events}
        }));
        hub.pending.insert(id.clone(), sender.into());
        (id, receiver)
    };
    let _pending = PendingCall {
        state: state.clone(),
        id,
    };
    match tokio::time::timeout(Duration::from_secs(3), receiver).await {
        Ok(Ok(reply)) if reply["status"] == "ok" => Ok(applied),
        Ok(_) => Err(error(409, "live_not_held")),
        Err(_) => Err(error(504, "live_input_timeout")),
    }
}

/// A phone page viewport: whole CSS px and a device pixel ratio, within phone and tablet screens.
pub(super) fn viewport(width: Option<u64>, height: Option<u64>, dpr: Option<f64>) -> Option<Value> {
    let (width, height, dpr) = (width?, height?, dpr?);
    ((200..=1280).contains(&width) && (200..=2000).contains(&height) && (1.0..=4.0).contains(&dpr))
        .then(|| json!({"width": width, "height": height, "dpr": dpr}))
}

fn validate_events(body: &Value) -> Option<(Uuid, u64, &[Value])> {
    let client = Uuid::parse_str(body["client"].as_str()?).ok()?;
    let seq = body["seq"].as_u64()?;
    let events = body["events"].as_array()?;
    let valid_client = client.get_version_num() == 4 && client.get_variant() == Variant::RFC4122;
    if !valid_client || events.is_empty() || events.len() > 64 {
        return None;
    }
    for event in events {
        let len = event.as_object()?.len();
        let in_range = |key: &str, min, max| {
            event[key]
                .as_f64()
                .is_some_and(|n| (min..=max).contains(&n))
        };
        let point = || in_range("x", 0.0, 1.0) && in_range("y", 0.0, 1.0);
        let valid = match event["t"].as_str()? {
            "down" | "move" | "up" => len == 3 && point(),
            "wheel" => {
                len == 5 && point() && in_range("dx", -4.0, 4.0) && in_range("dy", -4.0, 4.0)
            }
            "text" => {
                len == 2
                    && event["value"]
                        .as_str()
                        .is_some_and(|s| (1..=256).contains(&s.chars().count()))
            }
            "key" => {
                len == 2
                    && matches!(
                        event["key"].as_str(),
                        Some(
                            "Backspace"
                                | "Delete"
                                | "Enter"
                                | "Tab"
                                | "Escape"
                                | "ArrowUp"
                                | "ArrowDown"
                                | "ArrowLeft"
                                | "ArrowRight"
                                | "Home"
                                | "End"
                                | "PageUp"
                                | "PageDown"
                                | "Space"
                        )
                    )
            }
            "viewport" => {
                len == 4
                    && viewport(
                        event["width"].as_u64(),
                        event["height"].as_u64(),
                        event["dpr"].as_f64(),
                    )
                    .is_some()
            }
            _ => false,
        };
        if !valid {
            return None;
        }
    }
    Some((client, seq, events))
}
