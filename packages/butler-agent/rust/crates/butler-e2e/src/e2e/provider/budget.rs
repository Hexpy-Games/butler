//! Record-mode spend limit and upstream observations for live contract checks.
//!
//! With a budget, only requests for one user request reach the live upstream,
//! at most `responses` of them, plus at most `models` model-list reads. Every
//! other request (background work included) is refused with 501 and listed,
//! so a live run can never spend more calls than it declared.

use super::*;

pub(super) struct Budget {
    user_request: String,
    responses: u32,
    models: u32,
}

/// What the recorder saw from the upstream, without any secret value.
#[derive(Default)]
pub(super) struct Observed {
    pub(super) refused: Vec<String>,
    /// Response header names per forwarded exchange (`path`, sorted names).
    pub(super) header_names: Vec<(String, Vec<String>)>,
    /// `{slug, visibility}` of every model the upstream listed.
    pub(super) models: Option<Value>,
}

impl Provider {
    /// Limits record mode to `responses` upstream calls for `user_request`
    /// plus `models` model-list reads; everything else is refused.
    pub fn limit_recording(&self, user_request: &str, responses: u32, models: u32) {
        *lock(&self.state.budget) = Some(Budget {
            user_request: user_request.to_owned(),
            responses,
            models,
        });
    }

    /// Requests the budget refused (`path user_request`), in arrival order.
    pub fn refused(&self) -> Vec<String> {
        lock(&self.state.observed).refused.clone()
    }

    /// Sorted response header names of every forwarded exchange.
    pub fn upstream_header_names(&self) -> Vec<(String, Vec<String>)> {
        lock(&self.state.observed).header_names.clone()
    }

    /// `[{slug, visibility}]` from the forwarded `/v1/models` read, if any.
    pub fn upstream_models(&self) -> Option<Value> {
        lock(&self.state.observed).models.clone()
    }
}

/// Takes one unit of budget for a responses request, or refuses it.
pub(super) fn admit_response(state: &State, key: &cassette::MatchKey) -> bool {
    let mut budget = lock(&state.budget);
    let admitted = match budget.as_mut() {
        None => true,
        Some(budget) if budget.responses > 0 && key.user_request == budget.user_request => {
            budget.responses -= 1;
            true
        }
        Some(_) => false,
    };
    if !admitted {
        lock(&state.observed)
            .refused
            .push(format!("{} {}", key.path, key.user_request));
    }
    admitted
}

fn admit_models(state: &State) -> bool {
    let mut budget = lock(&state.budget);
    let admitted = match budget.as_mut() {
        None => true,
        Some(budget) if budget.models > 0 => {
            budget.models -= 1;
            true
        }
        Some(_) => false,
    };
    if !admitted {
        lock(&state.observed).refused.push("/v1/models".into());
    }
    admitted
}

pub(super) fn header_names(headers: &reqwest::header::HeaderMap) -> Vec<String> {
    let mut names: Vec<String> = headers
        .keys()
        .map(|name| name.as_str().to_owned())
        .collect();
    names.sort();
    names.dedup();
    names
}

/// Record mode without a fake authority: forwards the model-list read to
/// the live upstream and keeps only slugs, visibility and header names.
pub(super) async fn forward_models(
    state: &State,
    upstream: &str,
    client: &reqwest::Client,
    headers: &axum::http::HeaderMap,
) -> Response<Body> {
    if !admit_models(state) {
        return plain(501, "HARNESS_ERROR: record budget refused /v1/models");
    }
    let mut request = client.get(format!("{}/v1/models", upstream.trim_end_matches('/')));
    if let Some(auth) = headers.get("authorization") {
        request = request.header("authorization", auth.as_bytes());
    }
    let Ok(response) = request.send().await else {
        return plain(502, "HARNESS_ERROR: upstream /v1/models failed");
    };
    let status = response.status().as_u16();
    let names = header_names(response.headers());
    let bytes = response.bytes().await.unwrap_or_default();
    let summary = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|body| body["models"].as_array().cloned())
        .map(|models| {
            models
                .iter()
                .map(|m| serde_json::json!({"slug": m["slug"], "visibility": m["visibility"]}))
                .collect::<Vec<_>>()
        });
    {
        let mut observed = lock(&state.observed);
        observed.header_names.push(("/v1/models".into(), names));
        observed.models = summary.map(Value::from);
    }
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(bytes))
        .unwrap_or_default()
}
