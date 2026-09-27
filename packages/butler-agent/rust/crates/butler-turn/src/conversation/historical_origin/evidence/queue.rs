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
) -> QueueEvidence {
    let mut matches = HashMap::new();
    if locators.is_empty() {
        return QueueEvidence {
            complete: true,
            matches,
        };
    }
    let complete = scan(data_root, locators, started, cancellation, &mut matches).is_ok();
    QueueEvidence { complete, matches }
}

/// Scans the durable inbound queue for the candidates' events, in the
/// source's lexical order across all states, publishing matches every 500
/// records; a malformed record or the one-minute budget ends the scan.
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
    for state in ["failed", "pending", "processed", "processing"] {
        for path in queue_records(&root.join(state))? {
            if page_scanned == 500 {
                matches.extend(page_matches.drain());
                page_scanned = 0;
            }
            if cancellation.is_cancelled() || started.elapsed() >= Duration::from_secs(60) {
                return Err(evidence_error(
                    ConversationCode::MemoryOriginEvidenceUnavailable,
                ));
            }
            let record = read_record(&path)?;
            page_scanned += 1;
            let Some(event_id) = butler_core::json::at(&record, "/envelope/eventId").as_str()
            else {
                continue;
            };
            let Some(locator) = wanted.get(event_id) else {
                continue;
            };
            page_matches.insert(event_id.to_owned(), record_match(&record, locator)?);
        }
    }
    matches.extend(page_matches);
    Ok(())
}

/// The JSON record files of one queue state, in UTF-16 path order. Only
/// file names are kept; records are parsed one at a time.
fn queue_records(directory: &Path) -> ConversationResult<Vec<std::path::PathBuf>> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut names = fs::read_dir(directory)
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
    Ok(names)
}

/// A version-1 queue record with a queue id and an envelope event id.
fn read_record(path: &Path) -> ConversationResult<Value> {
    let bytes = fs::read(path).map_err(evidence_unavailable)?;
    let record: Value = serde_json::from_slice(&bytes).map_err(evidence_unavailable)?;
    if butler_core::json::at(&record, "/version").as_f64() != Some(1.0)
        || !butler_core::json::at(&record, "/queueId").is_string()
        || !butler_core::json::at(&record, "/envelope/eventId").is_string()
    {
        return Err(evidence_error(
            ConversationCode::MemoryOriginEvidenceUnavailable,
        ));
    }
    Ok(record)
}

/// Whether the record's routing matches the candidate and whether its
/// envelope is internal control, with the envelope digest as evidence.
fn record_match(record: &Value, locator: &HistoricalOriginCandidate) -> ConversationResult<Match> {
    let envelope = &butler_core::json::at(record, "/envelope");
    let matched = butler_core::json::at(envelope, "/routingHints/sessionId").as_str()
        == locator.external_session_id.as_deref()
        && (locator.turn_id.is_none()
            || butler_core::json::at(envelope, "/routingHints/turnId").as_str()
                == locator.turn_id.as_deref());
    let controls = &butler_core::json::at(envelope, "/executionControls");
    let controls_internal = !controls.is_null()
        && controls_valid(controls)?
        && super::truthy(butler_core::json::at(controls, "/subsession_result"));
    let internal = super::truthy(butler_core::json::at(envelope, "/nativeStewardContext"))
        || super::truthy(butler_core::json::at(envelope, "/control"))
        || super::truthy(butler_core::json::at(
            envelope,
            "/appTurnContext/authorityRequestRef",
        ))
        || super::truthy(butler_core::json::at(
            envelope,
            "/routingHints/authorityRequestRef",
        ))
        || controls_internal;
    let json = butler_core::json::stringify(envelope).map_err(evidence_unavailable)?;
    Ok(Match {
        matched,
        internal_control: internal,
        reference: butler_core::json::at(record, "/queueId")
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        sha256: sha256(json),
    })
}

pub(super) fn controls_valid(value: &Value) -> ConversationResult<bool> {
    if butler_core::json::at(value, "/schema_version") != "butler.turn-execution-controls.v1"
        || !nonempty(butler_core::json::at(value, "/turn_id"))
        || !nonempty(butler_core::json::at(value, "/session_id"))
        || !model_ref(butler_core::json::at(value, "/model_ref"))
        || !matches!(
            butler_core::json::at(value, "/reasoning_effort").as_str(),
            Some("none" | "low" | "medium" | "high" | "xhigh" | "max")
        )
        || !matches!(
            butler_core::json::at(value, "/access_mode").as_str(),
            Some("full_access" | "ask_first" | "read_only")
        )
        || !butler_core::json::at(value, "/plan_mode").is_boolean()
        || !matches!(
            butler_core::json::at(value, "/source").as_str(),
            Some("message_override" | "session_override" | "global_default")
        )
        || !butler_core::json::at(value, "/session_control_revision")
            .as_f64()
            .is_some_and(|number| {
                number.is_finite()
                    && number >= 0.0
                    && number.fract() == 0.0
                    && number <= 9_007_199_254_740_991.0
            })
        || !nonempty(butler_core::json::at(value, "/catalog_generation"))
        || !nonempty(butler_core::json::at(value, "/resolved_at"))
        || !nonempty(butler_core::json::at(value, "/integrity_hash"))
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
    let hash = butler_core::json::at(value, "/integrity_hash")
        .as_str()
        .ok_or_else(|| evidence_error(ConversationCode::MemoryOriginEvidenceUnavailable))?;
    let mut unsigned = value.clone();
    unsigned
        .as_object_mut()
        .ok_or_else(|| evidence_error(ConversationCode::MemoryOriginEvidenceUnavailable))?
        .shift_remove("integrity_hash");
    let json = butler_core::json::stringify(&unsigned).map_err(evidence_unavailable)?;
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
        .is_some_and(|text| !butler_core::public_text::trim_js_whitespace(text).is_empty())
}
fn model_ref(value: &Value) -> bool {
    nonempty(value) && value.as_str().is_some_and(|text| text.contains('/'))
}
fn fallback_valid(value: &Value) -> bool {
    value.is_object()
        && butler_core::json::at(value, "/enabled").is_boolean()
        && butler_core::json::at(value, "/models")
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
        && butler_core::json::at(value, "/safe_title")
            .as_str()
            .is_some_and(|text| {
                text.chars().all(|ch| {
                    let code = ch as u32;
                    code >= 32 && code != 127
                })
            })
}
