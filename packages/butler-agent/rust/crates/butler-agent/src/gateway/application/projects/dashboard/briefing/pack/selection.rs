//! Pure project/work/document selection facts for signpost packs.

use std::path::Path;

use serde_json::Value;

use super::super::super::contracts::{
    AppProjectDashboardLedgerRecord, AppProjectDashboardManagedWork, AppProjectDashboardWork,
};
use super::types::{Category, DocumentFact, Fact, Source, Unit};

pub(super) fn report_question(language: &str) -> &'static str {
    if language == "ko" {
        "이 보고의 내용과 미검증 사항에 관해 확인하기"
    } else {
        "Ask about this report and its unverified points"
    }
}

pub(in crate::gateway::application::projects::dashboard::briefing) fn resolve_language(
    data_root: &Path,
) -> String {
    normalize_language(std::env::var("BUTLER_RESPONSE_LANGUAGE").ok().as_deref())
        .or_else(|| {
            std::fs::read_to_string(data_root.join("butler.config.json"))
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .and_then(|value| {
                    value
                        .pointer("/user/responseLanguage")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .and_then(|value| normalize_language(Some(&value)))
        })
        .or_else(|| {
            std::fs::read_to_string(data_root.join("personas/active.md"))
                .ok()
                .and_then(|text| {
                    persona_language(&text).and_then(|value| normalize_language(Some(value)))
                })
        })
        .unwrap_or_else(|| "en".into())
}

fn normalize_language(value: Option<&str>) -> Option<String> {
    let value = crate::public_text::trim_js_whitespace(value?).to_lowercase();
    if value.is_empty() {
        None
    } else if value == "ko"
        || value == "kr"
        || value.contains("korean")
        || value.contains("한국")
        || value.contains("한글")
    {
        Some("ko".into())
    } else if value == "en" || value.contains("english") || value.contains("영어") {
        Some("en".into())
    } else {
        None
    }
}

fn persona_language(value: &str) -> Option<&str> {
    let lower = value.to_ascii_lowercase();
    let start = lower.find("**language:**")? + "**language:**".len();
    let remainder = &value[start..];
    let start = remainder
        .char_indices()
        .find(|(_, character)| !crate::public_text::is_js_whitespace(*character))
        .map_or(remainder.len(), |(index, _)| index);
    Some(remainder[start..].split('\n').next().unwrap_or(""))
}

pub(super) fn sorted_works(works: &[AppProjectDashboardWork]) -> Vec<AppProjectDashboardWork> {
    let mut works = works.to_vec();
    works.sort_by(|a, b| {
        let a_blocked = a
            .managed
            .as_ref()
            .is_some_and(|view| view.status == "blocked")
            || a.record.status == "blocked";
        let b_blocked = b
            .managed
            .as_ref()
            .is_some_and(|view| view.status == "blocked")
            || b.record.status == "blocked";
        b_blocked
            .cmp(&a_blocked)
            .then_with(|| a.record.priority.total_cmp(&b.record.priority))
            .then_with(|| b.record.updated_at.cmp(&a.record.updated_at))
            .then_with(|| a.record.id.cmp(&b.record.id))
    });
    works
}

pub(super) fn work_fact_parts(
    view: Option<&AppProjectDashboardManagedWork>,
    work: &AppProjectDashboardWork,
) -> (String, String, Vec<String>) {
    let disposition = view.and_then(|view| view.latest_disposition.as_ref());
    let checkpoint = view.and_then(|view| view.latest_checkpoint.as_ref());
    let latest_disposition = disposition.filter(|disposition| {
        checkpoint.is_none_or(|checkpoint| disposition.created_at >= checkpoint.created_at)
    });
    if let Some(disposition) = latest_disposition {
        return (
            disposition.created_at.clone(),
            disposition.summary.clone().unwrap_or_default(),
            disposition
                .remaining_actions
                .iter()
                .chain(&disposition.followups)
                .cloned()
                .chain(disposition.next_condition.iter().cloned())
                .collect(),
        );
    }
    let terminal =
        view.is_some_and(|view| matches!(view.status.as_str(), "completed" | "abandoned"));
    let proposals = if terminal {
        Vec::new()
    } else {
        checkpoint
            .and_then(|checkpoint| checkpoint.next_step.clone())
            .into_iter()
            .chain(view.into_iter().flat_map(|view| {
                view.latest_result_review
                    .iter()
                    .chain(view.latest_plan_review.iter())
                    .flat_map(|review| review.corrections.iter().cloned())
            }))
            .collect()
    };
    let proposals = if view.is_none()
        && matches!(
            work.record.status.as_str(),
            "proposed" | "scoped" | "specified"
        ) {
        proposals
            .into_iter()
            .chain(std::iter::once(work.record.title.clone()))
            .collect()
    } else {
        proposals
    };
    (
        checkpoint.map_or_else(
            || work.record.updated_at.clone(),
            |checkpoint| checkpoint.created_at.clone(),
        ),
        checkpoint
            .and_then(|checkpoint| checkpoint.public_summary.clone())
            .unwrap_or_default(),
        proposals,
    )
}

pub(super) fn document_unit(
    record: &AppProjectDashboardLedgerRecord,
    snapshot_revision: &str,
    budget: f64,
    safe: &impl Fn(&str) -> String,
) -> Unit {
    let source_id = format!("{}:{}", record.kind, record.id);
    let source = Source {
        source_id: source_id.clone(),
        kind: record.kind.clone(),
        id: record.id.clone(),
        revision: snapshot_revision.to_owned(),
        title: safe(&record.title),
        session_id: None,
    };
    let proposals = if record.kind == "plan"
        && record.parent_id.is_none()
        && matches!(
            record.status.as_str(),
            "active" | "draft" | "planned" | "todo"
        ) {
        vec![safe(&record.title)]
    } else {
        Vec::new()
    };
    Unit {
        source,
        fact: Fact::Document(DocumentFact {
            source_id,
            title: safe(&record.title),
            kind: record.kind.clone(),
            status: record.status.clone(),
            parent_id: record.parent_id.clone(),
            reported_at: record.updated_at.clone(),
            metadata_only: true,
            linked_user_followups: None,
        }),
        proposals,
        ceiling: 1_000.0 + (budget - 1_000.0) * 0.75,
        category: Category::Document,
    }
}
