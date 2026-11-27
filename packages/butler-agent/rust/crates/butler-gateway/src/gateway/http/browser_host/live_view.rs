use super::super::{
    APP_PROTOCOL_VERSION, ApiEnvelope, listeners::ListenerScope, query, security::Access,
};
use super::{Client, HttpError, HttpState, error, live, open_hand_off};
use axum::{
    body::{Body, Bytes},
    http::{HeaderValue, Method, Request, StatusCode, header},
    response::Response,
};
use bytes::{BufMut, BytesMut};
use futures_util::stream;
use serde_json::json;
use std::{convert::Infallible, sync::Arc, time::Duration};
use tokio::{sync::watch, time::Instant};
use tokio_util::sync::CancellationToken;

const FRAME_INTERVAL: Duration = Duration::from_millis(100);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(25);

pub(in crate::gateway::http) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    client: &Client,
) -> Result<Response, HttpError> {
    if matches!(client.access, Access::PublicAsset | Access::SignedResource) {
        return Err(error(403, "browser_live_forbidden"));
    }
    let (tab, suffix) = request
        .uri()
        .path()
        .strip_prefix("/browser/tabs/")
        .and_then(|path| path.split_once('/'))
        .ok_or_else(|| error(404, "not_found"))?;
    let input = match (request.method(), suffix) {
        (&Method::GET, "live") => false,
        (&Method::POST, "live/input") => true,
        _ => return Err(error(405, "method_not_allowed")),
    };
    if !(1..=128).contains(&tab.len())
        || !tab
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return Err(error(400, "invalid_tab"));
    }
    if input {
        let tab = tab.to_owned();
        let invalid = || error(400, "invalid_input");
        let bytes = super::super::read_body_with_limit(request.into_body(), 16 * 1024)
            .await
            .map_err(|_| invalid())?;
        let body = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        let data = live::input(&state, &tab, &body).await?;
        return super::super::json(
            StatusCode::OK,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data,
            },
        );
    }
    let params = query(request.uri());
    let args = if params.contains_key("height") || params.contains_key("dpr") {
        let whole = |key: &str| params.get(key).and_then(|v| v.parse::<u64>().ok());
        let dpr = params.get("dpr").and_then(|v| v.parse::<f64>().ok());
        let viewport = live::viewport(whole("width"), whole("height"), dpr)
            .ok_or_else(|| error(400, "invalid_viewport"))?;
        json!({"viewport": viewport})
    } else {
        let width = params.get("width").and_then(|v| v.parse::<i64>().ok());
        json!({"width": width.unwrap_or(720).clamp(320, 1280)})
    };
    let (session, _) = open_hand_off(&state, tab)
        .await?
        .ok_or_else(|| error(409, "no_hand_off"))?;
    let rotated = client.keys.live_streams();
    let closed = request
        .extensions()
        .get::<ListenerScope>()
        .map_or_else(CancellationToken::new, |scope| scope.closed.clone());
    let viewer = live::attach(&state, tab, &session, args).await?;
    let mut frames = viewer.feed.frame.subscribe();
    frames.mark_changed();
    let stream = ViewStream {
        state,
        viewer,
        frames,
        rotated,
        closed,
        meta: None,
        last_frame: None,
        heartbeat: Instant::now() + HEARTBEAT_INTERVAL,
        ended: false,
    };
    Ok(stream.into_response())
}

struct ViewStream {
    state: Arc<HttpState>,
    viewer: live::Viewer,
    frames: watch::Receiver<Option<Arc<live::Frame>>>,
    rotated: CancellationToken,
    closed: CancellationToken,
    meta: Option<(u32, u32)>,
    last_frame: Option<Instant>,
    heartbeat: Instant,
    ended: bool,
}

impl ViewStream {
    fn into_response(self) -> Response {
        let body = Body::from_stream(stream::unfold(self, |mut stream| async {
            stream
                .next()
                .await
                .map(|chunk| (Ok::<_, Infallible>(chunk), stream))
        }));
        let mut response = Response::new(body);
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/vnd.butler.browser-live"),
        );
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store, no-transform"),
        );
        headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
        response
    }

    async fn next(&mut self) -> Option<Bytes> {
        if self.ended {
            return None;
        }
        let state = self.state.clone();
        loop {
            let changed = state.browser.2.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if state.shutdown.is_cancelled()
                || self.rotated.is_cancelled()
                || self.closed.is_cancelled()
            {
                return None;
            }
            let feed = &self.viewer.feed;
            let reason = {
                let hub = state.browser.0.lock().ok()?;
                if hub.generation != feed.generation {
                    Some("host_lost")
                } else if !hub.tabs.contains(&feed.tab) {
                    Some("closed")
                } else if !hub.tabs.is_user(&feed.tab) {
                    Some("handed_back")
                } else {
                    None
                }
            };
            if let Some(reason) = reason {
                self.ended = true;
                return Some(record(4, json!({"reason": reason}).to_string().as_bytes()));
            }
            let frame = tokio::select! {
                biased;
                () = state.shutdown.cancelled() => return None,
                () = self.rotated.cancelled() => return None,
                () = self.closed.cancelled() => return None,
                () = &mut changed => continue,
                result = async {
                    if let Some(last) = self.last_frame {
                        tokio::time::sleep_until(last + FRAME_INTERVAL).await;
                    }
                    self.frames.changed().await.ok()?;
                    self.frames.borrow_and_update().clone()
                } => result,
                () = tokio::time::sleep_until(self.heartbeat) => {
                    self.heartbeat = Instant::now() + HEARTBEAT_INTERVAL;
                    return Some(record(3, &[]));
                }
            };
            if let Some(frame) = frame {
                let chunk = self.encode_frame(&frame);
                let now = Instant::now();
                self.last_frame = Some(now);
                self.heartbeat = now + HEARTBEAT_INTERVAL;
                return Some(chunk);
            }
        }
    }

    fn encode_frame(&mut self, frame: &live::Frame) -> Bytes {
        let dimensions = (frame.width, frame.height);
        let jpeg = record(2, &frame.jpeg);
        if self.meta == Some(dimensions) {
            return jpeg;
        }
        self.meta = Some(dimensions);
        let meta = record(
            1,
            json!({"width": frame.width, "height": frame.height})
                .to_string()
                .as_bytes(),
        );
        let mut chunk = BytesMut::with_capacity(meta.len() + jpeg.len());
        chunk.extend_from_slice(&meta);
        chunk.extend_from_slice(&jpeg);
        chunk.freeze()
    }
}

fn record(kind: u8, payload: &[u8]) -> Bytes {
    let mut bytes = BytesMut::with_capacity(5 + payload.len());
    bytes.put_u8(kind);
    bytes.put_u32(u32::try_from(payload.len()).unwrap_or_default());
    bytes.extend_from_slice(payload);
    bytes.freeze()
}
