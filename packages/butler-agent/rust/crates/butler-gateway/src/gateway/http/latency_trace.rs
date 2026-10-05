//! Paired request timings for complete storage E2E responses, absent in ordinary operation.
use axum::{body::Body, http::Request, response::Response};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
pub(super) fn start(request: &Request<Body>) -> Option<(u128, Instant)> {
    if request.uri().path() != "/session-view"
        || !matches!(
            std::env::var("BUTLER_E2E_TIER").as_deref(),
            Ok("stub" | "perf")
        )
        || std::env::var("BUTLER_E2E_STORAGE_METRICS").as_deref() != Ok("1")
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
