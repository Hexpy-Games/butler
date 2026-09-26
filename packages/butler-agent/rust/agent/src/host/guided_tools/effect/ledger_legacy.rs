//! Historical Project Ledger effect input, kept separate from current tool input.

use std::path::PathBuf;

use serde_json::{Map, Value};

use crate::btcc::{BlockerRelation, EffectBlocker, EffectFailure, effect_input_sha256};
use crate::project_ledger::{NativeProjectLedger, ProjectLedgerRecordUpdate};
use crate::public_text::trim_js_whitespace;

pub(super) fn updates(
    input: &Value,
) -> Result<Option<Vec<ProjectLedgerRecordUpdate>>, EffectFailure> {
    let Some(values) = input.get("updates").and_then(Value::as_array) else {
        return Ok(None);
    };
    normalize(values)?
        .into_iter()
        .enumerate()
        .map(|(index, value)| serde_json::from_value(value).map_err(|_| invalid(index)))
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

pub(super) async fn classify(
    ledger: &NativeProjectLedger,
    root: PathBuf,
    capability: &str,
    blocker: &EffectBlocker,
    target: &str,
    input: &Value,
) -> BlockerRelation {
    if blocker.capability != "project_ledger_update"
        || capability == "project_ledger_create"
        || input.get("operation").and_then(Value::as_str) != Some("update")
    {
        return BlockerRelation::Unrelated;
    }
    let (Some((kind, id)), Some((blocked_kind, blocked_id))) =
        (target_parts(target), target_parts(&blocker.target))
    else {
        return BlockerRelation::Unrelated;
    };
    if id != blocked_id || (blocked_kind != "*" && blocked_kind != kind) {
        return BlockerRelation::Unrelated;
    }
    let Some(values) = blocker.input.get("updates").and_then(Value::as_array) else {
        return BlockerRelation::Ambiguous;
    };
    let Ok(updates) = normalize(values) else {
        return BlockerRelation::Ambiguous;
    };
    let matches: Vec<_> = updates
        .into_iter()
        .filter(|update| update.get("id").and_then(Value::as_str) == Some(id))
        .collect();
    if matches.is_empty() {
        return BlockerRelation::Ambiguous;
    }
    let missing_kind = matches.iter().any(|update| update.get("kind").is_none());
    let inferred = if missing_kind {
        match ledger
            .find_canonical_record_kinds(root, id.to_owned())
            .await
        {
            Ok(kinds) if kinds.len() == 1 => kinds.into_iter().next(),
            _ => None,
        }
    } else {
        None
    };
    if missing_kind && inferred.is_none() {
        return BlockerRelation::Ambiguous;
    }
    let latest = matches
        .into_iter()
        .filter(|update| {
            update
                .get("kind")
                .and_then(Value::as_str)
                .or(inferred.as_deref())
                == Some(kind)
        })
        .next_back();
    let Some(Value::Object(mut comparable)) = latest else {
        return BlockerRelation::Overlapping;
    };
    comparable
        .entry("operation")
        .or_insert(Value::String("update".into()));
    if !comparable.contains_key("kind") {
        comparable.insert("kind".into(), Value::String(kind.to_owned()));
    }
    match (
        effect_input_sha256(&Value::Object(comparable)),
        effect_input_sha256(input),
    ) {
        (Ok(left), Ok(right)) if left == right => BlockerRelation::Equivalent,
        _ => BlockerRelation::Overlapping,
    }
}

fn normalize(values: &[Value]) -> Result<Vec<Value>, EffectFailure> {
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let raw = value.as_object().ok_or_else(|| invalid(index))?;
            let id = raw
                .get("id")
                .and_then(Value::as_str)
                .map(trim_js_whitespace)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| invalid(index))?;
            let mut normalized = Map::new();
            normalized.insert("id".into(), Value::String(id.to_owned()));
            for (source, target) in [
                ("kind", "kind"),
                ("title", "title"),
                ("status", "status"),
                ("body", "body"),
                ("spec", "spec"),
                ("acceptance", "acceptance"),
                ("validation", "validation"),
                ("review", "review"),
                ("report", "report"),
                ("implementation", "implementation"),
                ("mitigation", "mitigation"),
                ("reason", "reason"),
                ("code_commits", "codeCommits"),
                ("ledger_commits", "ledgerCommits"),
            ] {
                if let Some(text) = raw.get(source).and_then(Value::as_str) {
                    normalized.insert(target.into(), Value::String(text.to_owned()));
                }
            }
            Ok(Value::Object(normalized))
        })
        .collect()
}

fn target_parts(target: &str) -> Option<(&str, &str)> {
    let (kind, id) = target.strip_prefix("project-ledger:")?.split_once(':')?;
    (!kind.is_empty() && !id.is_empty()).then_some((kind, id))
}

fn invalid(index: usize) -> EffectFailure {
    EffectFailure::policy(
        "project_ledger_effect_input_invalid",
        format!("Project Ledger legacy effect update {index} is invalid"),
    )
}
