mod eligibility;
use std::collections::HashSet;
use std::path::Path;

use serde_json::Value;

use super::contracts::{
    CanonicalProfileSourceFactory, ProfileResult, ProfilingMode, ReflectiveProfileSummary,
    RuntimeProfileProjection,
};
use super::storage::{self, StoredEntry};

const MAX_HINTS: usize = 6;
const MAX_HINT_UNITS: usize = 240;

pub(super) fn read_current(
    data_root: &Path,
    sources: &dyn CanonicalProfileSourceFactory,
    now_ms: i64,
) -> ProfileResult<Option<RuntimeProfileProjection>> {
    let consent = storage::read_consent(data_root);
    if consent.mode == ProfilingMode::Off {
        return Ok(None);
    }
    let Some(stored) = storage::read_projection(data_root)? else {
        return Ok(None);
    };
    let stored = normalize(stored);
    if stored.mode != consent.mode.as_str() || stored.writer_kind.is_none() {
        return Ok(None);
    }
    if stored.writer_kind.as_deref() == Some("manual") {
        return Ok(Some(stored));
    }
    let entries = storage::stable_entries(data_root)?;
    let entries = eligibility::eligible_sources(data_root, sources, entries, consent.mode, now_ms)?;
    if entries.is_empty() {
        return Ok(None);
    }
    Ok(Some(build(
        entries,
        consent.mode,
        Some(stored.version),
        Some(stored.updated_at),
    )))
}

pub(super) fn build_current(
    data_root: &Path,
    sources: &dyn CanonicalProfileSourceFactory,
    mode: ProfilingMode,
    now_ms: i64,
    version: f64,
    updated_at: String,
) -> ProfileResult<Option<RuntimeProfileProjection>> {
    let entries = storage::stable_entries(data_root)?;
    let entries = eligibility::eligible_sources(data_root, sources, entries, mode, now_ms)?;
    if entries.is_empty() {
        return Ok(None);
    }
    Ok(Some(build(entries, mode, Some(version), Some(updated_at))))
}

pub(super) fn correction_entries(
    data_root: &Path,
    sources: &dyn CanonicalProfileSourceFactory,
    mode: ProfilingMode,
    now_ms: i64,
) -> ProfileResult<Vec<StoredEntry>> {
    eligibility::eligible_sources(
        data_root,
        sources,
        storage::stable_entries(data_root)?,
        mode,
        now_ms,
    )
}

pub(super) fn correction_entries_in_db(
    data_root: &Path,
    sources: &dyn CanonicalProfileSourceFactory,
    db: &rusqlite::Connection,
    mode: ProfilingMode,
    now_ms: i64,
) -> ProfileResult<Vec<StoredEntry>> {
    eligibility::eligible_sources_in_db(
        data_root,
        sources,
        Some(db),
        storage::stable_entries_in_db(db)?,
        mode,
        now_ms,
    )
}

pub(super) fn normalize(mut value: RuntimeProfileProjection) -> RuntimeProfileProjection {
    value.version = if value.version.is_finite() && value.version >= 0.0 {
        value.version.floor()
    } else {
        0.0
    };
    if !matches!(value.mode.as_str(), "basic" | "deep") {
        value.mode = "basic".into();
    }
    if value.updated_at.is_empty() {
        value.updated_at = "1970-01-01T00:00:00.000Z".into();
    }
    value.how_to_answer = hints(if value.how_to_answer.is_empty() {
        &value.response_hints
    } else {
        &value.how_to_answer
    });
    value.how_to_collaborate = hints(&value.how_to_collaborate);
    value.response_hints = value.how_to_answer.clone();
    value.current_attention = hints(&value.current_attention);
    value.active_boundaries = hints(&value.active_boundaries);
    value.likely_failure_modes = hints(&value.likely_failure_modes);
    value.ask_before = hints(&value.ask_before);
    let fallback_cautions = [
        value.active_boundaries.clone(),
        value.likely_failure_modes.clone(),
        value.ask_before.clone(),
    ]
    .concat();
    value.caution_hints = hints(if value.caution_hints.is_empty() {
        &fallback_cautions
    } else {
        &value.caution_hints
    });
    value.writer_kind = value
        .writer_kind
        .filter(|kind| matches!(kind.as_str(), "manual" | "generated"));
    value.source_entry_ids = value.source_entry_ids.map(unique);
    value
}

fn build(
    entries: Vec<StoredEntry>,
    mode: ProfilingMode,
    version: Option<f64>,
    updated: Option<String>,
) -> RuntimeProfileProjection {
    let mut answer = Vec::new();
    let mut collaborate = Vec::new();
    let mut attention = Vec::new();
    let mut boundaries = Vec::new();
    let mut failures = Vec::new();
    let mut ask = Vec::new();
    let ids = entries.iter().map(|entry| entry.id.clone()).collect();
    for entry in entries {
        let summary = text(&entry.payload, "summary").unwrap_or("").to_owned();
        let should = strings(&entry.payload, "butler_should");
        let should_not = strings(&entry.payload, "butler_should_not");
        match (text(&entry.payload, "layer"), entry.category.as_str()) {
            (Some("current_attention"), _) => attention.push(summary),
            (Some("narrative_meaning"), _) => collaborate.push(summary),
            (_, "communication") => answer.extend(if should.is_empty() {
                vec![summary]
            } else {
                should
            }),
            (_, "epistemic_style") => {
                answer.extend(if should.is_empty() {
                    vec![summary]
                } else {
                    should
                });
                failures.extend(should_not)
            }
            (_, "boundaries") => {
                boundaries.push(summary.clone());
                boundaries.extend(should_not);
                if text(&entry.payload, "sensitivity") != Some("normal") {
                    ask.push(summary)
                }
            }
            (Some("contextual_adaptation"), _) => collaborate.extend(if should.is_empty() {
                vec![summary]
            } else {
                should
            }),
            _ => {
                if entry.category == "affective_landscape" {
                    failures.push(summary.clone())
                }
                collaborate.push(summary)
            }
        }
    }
    let answer = hints(&answer);
    let boundaries = hints(&boundaries);
    let failures = hints(&failures);
    let ask = hints(&ask);
    normalize(RuntimeProfileProjection {
        version: version.unwrap_or(0.0),
        mode: mode.as_str().into(),
        updated_at: updated.unwrap_or_default(),
        how_to_answer: answer.clone(),
        how_to_collaborate: hints(&collaborate),
        response_hints: answer,
        current_attention: hints(&attention),
        active_boundaries: boundaries.clone(),
        likely_failure_modes: failures.clone(),
        ask_before: ask.clone(),
        caution_hints: hints(&[boundaries, failures, ask].concat()),
        writer_kind: Some("generated".into()),
        source_entry_ids: Some(ids),
    })
}

pub(super) fn render(value: &RuntimeProfileProjection) -> String {
    let mut lines=vec!["# Runtime Profile Projection".into(),"".into(),format!("- Mode: {}",value.mode),format!("- Version: {}",value.version),"".into(),"Use these as lightweight adaptation hints. Do not treat them as a raw biography or expose them as profile data.".into()];
    for (title, items) in [
        ("How to answer", &value.how_to_answer),
        ("How to collaborate", &value.how_to_collaborate),
        ("Current attention", &value.current_attention),
        ("Active boundaries", &value.active_boundaries),
        ("Likely failure modes", &value.likely_failure_modes),
        ("Ask before", &value.ask_before),
    ] {
        if items.is_empty() {
            continue;
        }
        lines.push("".into());
        lines.push(format!("## {title}"));
        lines.extend(items.iter().take(6).map(|item| format!("- {item}")))
    }
    lines.join("\n")
}

pub(super) fn reflective(
    data_root: &Path,
    locale: &str,
) -> ProfileResult<ReflectiveProfileSummary> {
    let consent = storage::read_consent(data_root);
    if consent.mode == ProfilingMode::Off {
        return Ok(summary(
            false,
            consent.mode,
            0,
            if locale == "ko" {
                "프로파일링이 꺼져 있어, 사용자를 장기 프로필로 해석하지 않습니다."
            } else {
                "Profiling is off, so Butler is not maintaining a long-term user profile."
            },
            vec![],
        ));
    }
    let entries = storage::stable_entries(data_root)?;
    if entries.is_empty() {
        return Ok(summary(
            true,
            consent.mode,
            0,
            if locale == "ko" {
                "아직 확정적으로 정리된 프로필 항목은 없습니다. Butler는 먼저 후보로 관찰하고, 명시성이나 반복성이 충분할 때만 반영합니다."
            } else {
                "No stable profile entries have been consolidated yet. Butler keeps observations as candidates first and only promotes them when evidence is sufficient."
            },
            vec![],
        ));
    }
    let count = entries.len();
    let order = [
        "cares",
        "values",
        "epistemic_style",
        "communication",
        "aesthetics",
        "boundaries",
        "agency",
        "identity",
        "narrative",
        "affective_landscape",
        "relationships",
    ];
    let mut bullets = Vec::new();
    for category in order {
        for entry in entries.iter().filter(|entry| entry.category == category) {
            let facet = text(&entry.payload, "facet");
            let label = if locale == "ko" {
                category_ko(category)
            } else {
                category
            };
            bullets.push(format!(
                "{}{suffix}: {}",
                label,
                text(&entry.payload, "summary").unwrap_or(""),
                suffix = facet.map(|facet| format!("/{facet}")).unwrap_or_default()
            ));
            if bullets.len() == 8 {
                break;
            }
        }
        if bullets.len() == 8 {
            break;
        }
    }
    Ok(summary(
        true,
        consent.mode,
        count,
        if locale == "ko" {
            "지금까지의 명시 피드백과 반복 관찰을 바탕으로 Butler가 조심스럽게 형성한 이해입니다. 단정이 아니라 현재까지의 작업 가설입니다."
        } else {
            "This is Butler's careful current understanding from explicit feedback and repeated observations. It is a working interpretation, not a fixed judgment."
        },
        bullets,
    ))
}
fn summary(
    enabled: bool,
    mode: ProfilingMode,
    count: usize,
    text: &str,
    bullets: Vec<String>,
) -> ReflectiveProfileSummary {
    ReflectiveProfileSummary {
        ok: true,
        profiling_enabled: enabled,
        mode,
        entry_count: count,
        summary: text.into(),
        bullets,
        raw_profile_included: false,
    }
}
fn strings(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}
fn unique(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| {
            let value = crate::public_text::trim_js_whitespace(value);
            !value.is_empty() && seen.insert(value.to_owned())
        })
        .collect()
}
fn hints(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| super::naming::collapse_js_whitespace(value))
        .filter(|value| !value.is_empty())
        .map(|value| super::naming::bounded(&value, MAX_HINT_UNITS))
        .take(MAX_HINTS)
        .collect()
}
fn category_ko(value: &str) -> &str {
    match value {
        "identity" => "정체성",
        "cares" => "관심",
        "values" => "가치",
        "narrative" => "서사",
        "agency" => "목표",
        "epistemic_style" => "판단 방식",
        "communication" => "소통 방식",
        "affective_landscape" => "정서적 패턴",
        "relationships" => "관계",
        "aesthetics" => "취향",
        "boundaries" => "경계",
        _ => value,
    }
}
