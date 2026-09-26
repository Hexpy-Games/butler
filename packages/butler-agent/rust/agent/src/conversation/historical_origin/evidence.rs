//! Read-only historical ingress evidence. Missing sources are not positive evidence.

mod app;
mod btcc;
mod queue;

use std::{
    path::Path,
    time::{Duration, Instant},
};

use super::super::{ConversationOriginEvidence, HistoricalOriginCandidate};
use tokio_util::sync::CancellationToken;

pub(super) fn validate_outbox(
    data_root: &Path,
    started: Instant,
    cancellation: &CancellationToken,
) -> Result<(), &'static str> {
    btcc::validate_outbox(data_root, started, cancellation)
}

pub(super) struct UserEvidence {
    pub public_ingress: bool,
    pub internal_control: bool,
    pub available: bool,
    pub evidence: Vec<ConversationOriginEvidence>,
    pub outbox: Option<ConversationOriginEvidence>,
}

pub(super) fn read_page(
    data_root: &Path,
    rows: &[HistoricalOriginCandidate],
    started: Instant,
    cancellation: &CancellationToken,
) -> Result<Vec<UserEvidence>, &'static str> {
    let locators = rows
        .iter()
        .filter(|row| {
            row.origin_version.is_none()
                && row.external_session_id.is_some()
                && row.source_ref.is_some()
        })
        .collect::<Vec<_>>();
    let queue = queue::read(data_root, &locators, started, cancellation)?;
    rows.iter()
        .map(|row| {
            if cancellation.is_cancelled() || started.elapsed() >= Duration::from_secs(60) {
                return Err("memory_origin_evidence_unavailable");
            }
            let admission = btcc::admission(data_root, row);
            let app = app::read(data_root, row);
            let outbox = btcc::subsession_evidence(data_root, row)?;
            let inbound = row
                .source_ref
                .as_ref()
                .and_then(|key| queue.matches.get(key));
            let mut evidence = admission.evidence;
            evidence.extend(app.evidence);
            if let Some(item) = inbound.filter(|item| item.matched) {
                evidence.push(ConversationOriginEvidence {
                    kind: "gateway_ingress".into(),
                    reference: item.reference.clone(),
                    sha256: Some(item.sha256.clone()),
                });
            }
            let internal = admission.internal_control
                || app.internal_control
                || inbound.is_some_and(|item| item.internal_control);
            let positive = admission.public_ingress
                || app.matched && !app.internal_control
                || inbound.is_some_and(|item| item.matched && !item.internal_control);
            Ok(UserEvidence {
                public_ingress: positive,
                internal_control: internal,
                available: positive
                    || internal
                    || admission.available && app.available && queue.complete,
                evidence,
                outbox,
            })
        })
        .collect()
}

pub(super) struct SourceEvidence {
    available: bool,
    matched: bool,
    public_ingress: bool,
    internal_control: bool,
    evidence: Vec<ConversationOriginEvidence>,
}

impl SourceEvidence {
    fn absent() -> Self {
        Self {
            available: true,
            matched: false,
            public_ingress: false,
            internal_control: false,
            evidence: Vec::new(),
        }
    }
    fn unavailable() -> Self {
        Self {
            available: false,
            ..Self::absent()
        }
    }
}

fn sha256(bytes: impl AsRef<[u8]>) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

fn truthy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(value) => *value,
        serde_json::Value::Number(value) => value
            .as_f64()
            .is_some_and(|value| value != 0.0 && !value.is_nan()),
        serde_json::Value::String(value) => !value.is_empty(),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => true,
    }
}

fn js_string(value: &serde_json::Value) -> Option<String> {
    if !truthy(value) {
        return None;
    }
    Some(js_to_string(value))
}

fn js_to_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Array(values) => values
            .iter()
            .map(|value| match value {
                serde_json::Value::Null => String::new(),
                _ => js_to_string(value),
            })
            .collect::<Vec<_>>()
            .join(","),
        serde_json::Value::Object(_) => "[object Object]".into(),
        _ => crate::json::stringify(value).unwrap_or_default(),
    }
}
