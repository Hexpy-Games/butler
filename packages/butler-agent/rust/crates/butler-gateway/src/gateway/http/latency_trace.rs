//! Paired request timings for complete storage E2E responses, only in E2E fixture builds.
use axum::{body::Body, http::Request, response::Response};
use std::time::Instant;
#[cfg(feature = "e2e-fixtures")]
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(not(feature = "e2e-fixtures"))]
pub(super) fn start(_: &Request<Body>) -> Option<(u128, Instant)> {
    None
}
#[cfg(feature = "e2e-fixtures")]
pub(super) fn start(request: &Request<Body>) -> Option<(u128, Instant)> {
    if !matches!(
        request.uri().path(),
        "/session-view" | "/authority-permissions"
    ) || !crate::gateway::faults::latency_trace()
    {
        return None;
    }
    Some((
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_micros(),
        Instant::now(),
    ))
}
pub(super) fn finish(timing: Option<(u128, Instant)>, response: &mut Response) {
    if let Some((unix_us, started)) = timing
        && let Ok(value) = format!("{unix_us},{}", started.elapsed().as_micros()).parse()
    {
        response
            .headers_mut()
            .insert("x-butler-e2e-dispatch-us", value);
    }
}
