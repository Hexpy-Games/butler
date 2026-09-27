use std::{
    collections::HashMap,
    fs,
    path::Path,
    time::{Duration, Instant},
};

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::{
    ConversationCode, ConversationResult, HistoricalOriginCandidate, evidence_error,
    evidence_unavailable, sha256,
};

pub(super) struct Match {
    pub matched: bool,
    pub internal_control: bool,
    pub reference: String,
    pub sha256: String,
}
pub(super) struct QueueEvidence {
    pub complete: bool,
    pub matches: HashMap<String, Match>,
}

pub(super) fn read(
    data_root: &Path,
    locators: &[&HistoricalOriginCandidate],
    started: Instant,
    cancellation: &CancellationToken,
) -> ConversationResult<QueueEvidence> {
    let mut matches = HashMap::new();
    if locators.is_empty() {
        return Ok(QueueEvidence {
            complete: true,
            matches,
        });
    }
    let complete = scan(data_root, locators, started, cancellation, &mut matches).is_ok();
    Ok(QueueEvidence { complete, matches })
}

fn scan(
    data_root: &Path,
    locators: &[&HistoricalOriginCandidate],
    started: Instant,
    cancellation: &CancellationToken,
    matches: &mut HashMap<String, Match>,
) -> ConversationResult<()> {
    let wanted = locators
        .iter()
        .filter_map(|row| row.source_ref.as_deref().map(|key| (key, *row)))
        .collect::<HashMap<_, _>>();
    let root = data_root.join("runtime/inbound-events");
    let mut page_matches = HashMap::new();
    let mut page_scanned = 0usize;
    // The source scans lexically ordered durable queue records across all states.
    // Keep only filenames and one parsed envelope at a time.
    for state in ["failed", "pending", "processed", "processing"] {
        let directory = root.join(state);
        if !directory.exists() {
            continue;
        }
        let mut names = fs::read_dir(&directory)
            .map_err(evidence_unavailable)?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(evidence_unavailable)?;
        names.retain(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        });
        names.sort_by(|left, right| {
            left.as_os_str()
                .to_string_lossy()
                .encode_utf16()
                .cmp(right.as_os_str().to_string_lossy().encode_utf16())
        });
        for path in names {
            if page_scanned == 500 {
                matches.extend(page_matches.drain());
                page_scanned = 0;
            }
            if cancellation.is_cancelled() || started.elapsed() >= Duration::from_secs(60) {
                return Err(evidence_error(
                    ConversationCode::MemoryOriginEvidenceUnavailable,
                ));
            }
            let bytes = fs::read(path).map_err(evidence_unavailable)?;
            let record: Value = serde_json::from_slice(&bytes).map_err(evidence_unavailable)?;
            if record["version"].as_f64() != Some(1.0)
                || !record["queueId"].is_string()
                || !record["envelope"]["eventId"].is_string()
            {
                return Err(evidence_error(
                    ConversationCode::MemoryOriginEvidenceUnavailable,
                ));
            }
            page_scanned += 1;
            let envelope = &record["envelope"];
            let Some(event_id) = envelope["eventId"].as_str() else {
                continue;
            };
            let Some(locator) = wanted.get(event_id) else {
                continue;
            };
            let matched = envelope["routingHints"]["sessionId"].as_str()
                == locator.external_session_id.as_deref()
                && (locator.turn_id.is_none()
                    || envelope["routingHints"]["turnId"].as_str() == locator.turn_id.as_deref());
            let controls = &envelope["executionControls"];
            let controls_internal = !controls.is_null()
                && controls_valid(controls)?
                && super::truthy(&controls["subsession_result"]);
            let internal = super::truthy(&envelope["nativeStewardContext"])
                || super::truthy(&envelope["control"])
                || super::truthy(&envelope["appTurnContext"]["authorityRequestRef"])
                || super::truthy(&envelope["routingHints"]["authorityRequestRef"])
                || controls_internal;
            let json = crate::json::stringify(envelope).map_err(evidence_unavailable)?;
            page_matches.insert(
                event_id.to_owned(),
                Match {
                    matched,
                    internal_control: internal,
                    reference: record["queueId"].as_str().unwrap_or_default().to_owned(),
                    sha256: sha256(json),
                },
            );
        }
    }
    matches.extend(page_matches);
    Ok(())
}

pub(super) fn controls_valid(value: &Value) -> ConversationResult<bool> {
    if value["schema_version"] != "butler.turn-execution-controls.v1"
        || !nonempty(&value["turn_id"])
        || !nonempty(&value["session_id"])
        || !model_ref(&value["model_ref"])
        || !matches!(
            value["reasoning_effort"].as_str(),
            Some("none" | "low" | "medium" | "high" | "xhigh" | "max")
        )
        || !matches!(
            value["access_mode"].as_str(),
            Some("full_access" | "ask_first" | "read_only")
        )
        || !value["plan_mode"].is_boolean()
        || !matches!(
            value["source"].as_str(),
            Some("message_override" | "session_override" | "global_default")
        )
        || !value["session_control_revision"]
            .as_f64()
            .is_some_and(|number| {
                number.is_finite()
                    && number >= 0.0
                    && number.fract() == 0.0
                    && number <= 9_007_199_254_740_991.0
            })
        || !nonempty(&value["catalog_generation"])
        || !nonempty(&value["resolved_at"])
        || !nonempty(&value["integrity_hash"])
        || value
            .get("model_fallback")
            .is_some_and(|fallback| !fallback_valid(fallback))
        || value
            .get("subsession_result")
            .is_some_and(|subsession| !subsession_valid(subsession))
    {
        return Err(evidence_error(
            ConversationCode::MemoryOriginEvidenceUnavailable,
        ));
    }
    let hash = value["integrity_hash"]
        .as_str()
        .ok_or_else(|| evidence_error(ConversationCode::MemoryOriginEvidenceUnavailable))?;
    let mut unsigned = value.clone();
    unsigned
        .as_object_mut()
        .ok_or_else(|| evidence_error(ConversationCode::MemoryOriginEvidenceUnavailable))?
        .shift_remove("integrity_hash");
    let json = crate::json::stringify(&unsigned).map_err(evidence_unavailable)?;
    if sha256(json) != hash {
        return Err(evidence_error(
            ConversationCode::MemoryOriginEvidenceUnavailable,
        ));
    }
    Ok(true)
}

fn nonempty(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| !crate::public_text::trim_js_whitespace(text).is_empty())
}
fn model_ref(value: &Value) -> bool {
    nonempty(value) && value.as_str().is_some_and(|text| text.contains('/'))
}
fn fallback_valid(value: &Value) -> bool {
    value.is_object()
        && value["enabled"].is_boolean()
        && value["models"]
            .as_array()
            .is_some_and(|models| models.iter().all(model_ref))
}
fn subsession_valid(value: &Value) -> bool {
    value.is_object()
        && ["relation_id", "result_id", "safe_title"]
            .iter()
            .all(|key| {
                nonempty(&value[*key])
                    && value[*key]
                        .as_str()
                        .is_some_and(|text| text.encode_utf16().count() <= 160)
            })
        && value["safe_title"].as_str().is_some_and(|text| {
            text.chars().all(|ch| {
                let code = ch as u32;
                code >= 32 && code != 127
            })
        })
}
