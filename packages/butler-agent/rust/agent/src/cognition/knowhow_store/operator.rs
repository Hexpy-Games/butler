use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

use crate::cognition::{CognitionResult, FeedbackTarget};

use super::{KnowHowAggregateReport, KnowHowService, entries, error, quality};

impl KnowHowService {
    pub(crate) async fn operator_entries(&self) -> CognitionResult<Vec<Value>> {
        self.with_lease("knowhow_operator_list", |root| list(&root))
            .await
    }

    pub(crate) async fn operator_read(&self, id: &str) -> CognitionResult<Option<Value>> {
        let id = id.to_owned();
        self.with_lease("knowhow_operator_show", move |root| read(&root, &id))
            .await
    }

    pub(crate) async fn operator_disable(&self, id: &str) -> CognitionResult<Option<Value>> {
        let id = id.to_owned();
        self.with_lease("knowhow_operator_disable", move |root| disable(&root, &id))
            .await
    }

    pub(crate) async fn operator_retrieve(
        &self,
        query: &str,
        limit: usize,
        feedback: &[FeedbackTarget],
    ) -> CognitionResult<Value> {
        let query = query.to_owned();
        let feedback = feedback.to_vec();
        self.with_lease("knowhow_operator_retrieve", move |root| {
            retrieve(&root, &query, limit, &feedback)
        })
        .await
    }

    pub(crate) async fn operator_source_quality(&self) -> CognitionResult<Vec<Value>> {
        self.with_lease("knowhow_operator_quality", |root| source_quality(&root))
            .await
    }

    pub(crate) async fn operator_rebuild_index(&self) -> CognitionResult<Value> {
        let report: KnowHowAggregateReport = self.aggregate_and_rebuild().await?;
        let index_path = self
            .paths
            .cognition_root(&self.data_root)
            .join("know-how/index.sqlite");
        Ok(json!({
            "indexed_count": report.knowhow_indexed_count,
            "source_quality_count": report.source_quality_summary_count,
            "index_path": index_path.to_string_lossy(),
        }))
    }
}

pub(super) fn list(root: &Path) -> CognitionResult<Vec<Value>> {
    entries::list_paths(root)?
        .iter()
        .map(|path| entries::read_one(root, path))
        .collect()
}

pub(super) fn read(root: &Path, id: &str) -> CognitionResult<Option<Value>> {
    entries::read_id(root, id)
}

pub(super) fn disable(root: &Path, id: &str) -> CognitionResult<Option<Value>> {
    let Some(mut entry) = entries::read_id(root, id)? else {
        return Ok(None);
    };
    let object = entry
        .as_object_mut()
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
    let previous_status = object
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?
        .to_owned();
    object.insert("status".into(), json!("disabled"));
    object.insert("updated_at".into(), json!(now_iso()));
    object
        .get_mut("revision_history")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?
        .push(json!({
            "at": now_iso(),
            "kind": "operator_disable",
            "previous_status": previous_status,
        }));
    entries::write(root, &entry)?;
    Ok(Some(entry))
}

pub(super) fn retrieve(
    root: &Path,
    query: &str,
    limit: usize,
    feedback: &[FeedbackTarget],
) -> CognitionResult<Value> {
    let normalized_query = normalize(query);
    let query_tokens = tokenize(&normalized_query);
    let entries = list(root)?;
    let mut candidates = entries
        .into_iter()
        .filter(|entry| {
            matches!(
                string(entry, "status"),
                Some("active" | "candidate" | "needs_review")
            )
        })
        .map(|entry| {
            let match_score = match_score(&entry, &normalized_query, &query_tokens)?;
            let id = string(&entry, "knowhow_id")
                .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
            let preferred_sources = entry
                .pointer("/strategy/preferred_sources")
                .and_then(Value::as_array)
                .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
            let suppressed = feedback
                .iter()
                .filter(|feedback| {
                    feedback.target_ref == format!("knowhow:{id}")
                        || preferred_sources.iter().any(|source| {
                            source.as_str().is_some_and(|source| {
                                feedback.target_ref == format!("source:{source}")
                            })
                        })
                })
                .filter(|feedback| {
                    feedback.category.contains("policy")
                        || feedback.category.contains("quality")
                        || feedback.promotion_target.contains("know")
                })
                .map(|feedback| feedback.feedback_id.clone())
                .collect::<Vec<_>>();
            let quality_score = entry
                .pointer("/quality/score")
                .and_then(Value::as_f64)
                .ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
            let final_score = if suppressed.is_empty() {
                round3(match_score * 0.65 + quality_score * 0.35)
            } else {
                0.0
            };
            Ok(json!({
                "entry": entry,
                "match_score": match_score,
                "quality_score": quality_score,
                "final_score": final_score,
                "suppressed_by_feedback_ids": suppressed,
            }))
        })
        .collect::<CognitionResult<Vec<Value>>>()?;
    candidates.retain(|candidate| candidate["match_score"].as_f64().unwrap_or(0.0) > 0.0);
    candidates.sort_by(|left, right| {
        right["final_score"]
            .as_f64()
            .unwrap_or(0.0)
            .total_cmp(&left["final_score"].as_f64().unwrap_or(0.0))
    });
    candidates.truncate(limit);
    let selected = candidates
        .iter()
        .find(|candidate| candidate["final_score"].as_f64().unwrap_or(0.0) > 0.0)
        .map(|candidate| candidate["entry"].clone())
        .unwrap_or(Value::Null);
    Ok(json!({
        "query": query,
        "selected": selected,
        "candidates": candidates,
    }))
}

pub(super) fn source_quality(root: &Path) -> CognitionResult<Vec<Value>> {
    quality::aggregate(root).map(|summaries| {
        summaries
            .into_iter()
            .map(|summary| {
                json!({
                    "source_id": summary.source_id,
                    "tool_name": summary.tool_name,
                    "event_count": summary.event_count,
                    "success_count": summary.success_count,
                    "failure_count": summary.failure_count,
                    "negative_feedback_count": summary.negative_feedback_count,
                    "average_freshness_score": summary.average_freshness_score,
                    "average_latency_ms": summary.average_latency_ms,
                    "score": summary.score,
                    "last_observed_at": summary.last_observed_at,
                })
            })
            .collect()
    })
}

fn match_score(entry: &Value, query: &str, query_tokens: &[String]) -> CognitionResult<f64> {
    let name = string(entry, "name").ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
    let aliases = string_array(entry, "/aliases")?;
    let topics = string_array(entry, "/intent_match/topics")?;
    let examples = string_array(entry, "/intent_match/examples")?;
    let summary = string(entry, "summary").ok_or_else(|| error("memory_knowhow_entry_invalid"))?;
    let buckets = std::iter::once((name, 1.0))
        .chain(aliases.iter().map(|value| (value.as_str(), 0.95)))
        .chain(topics.iter().map(|value| (value.as_str(), 0.8)))
        .chain(examples.iter().map(|value| (value.as_str(), 0.65)))
        .chain(std::iter::once((summary, 0.35)));
    let mut best: f64 = 0.0;
    for (value, weight) in buckets {
        let normalized = normalize(value);
        if !normalized.is_empty() && query.contains(&normalized) {
            best = best.max(weight);
        }
        let tokens = tokenize(&normalized);
        if !tokens.is_empty() {
            let overlap = tokens
                .iter()
                .filter(|token| query_tokens.contains(token))
                .count();
            best = best.max((overlap as f64 / tokens.len() as f64) * weight);
        }
    }
    Ok(round3(best))
}

fn string_array(value: &Value, pointer: &str) -> CognitionResult<Vec<String>> {
    value
        .pointer(pointer)
        .and_then(Value::as_array)
        .ok_or_else(|| error("memory_knowhow_entry_invalid"))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| error("memory_knowhow_entry_invalid"))
        })
        .collect()
}

fn normalize(value: &str) -> String {
    value
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn tokenize(value: &str) -> Vec<String> {
    let mut tokens = Vec::<String>::new();
    let mut token = String::new();
    for character in value.chars() {
        if character.is_alphanumeric() || matches!(character, '_' | '-') {
            token.push(character);
        } else if !token.is_empty() {
            if token.encode_utf16().count() >= 2 {
                tokens.push(std::mem::take(&mut token));
            } else {
                token.clear();
            }
        }
    }
    if token.encode_utf16().count() >= 2 {
        tokens.push(token);
    }
    tokens.sort();
    tokens.dedup();
    tokens
}

fn string<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}

fn round3(value: f64) -> f64 {
    (value * 1_000.0).round() / 1_000.0
}

fn now_millis() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(i64::MAX as u128),
    )
    .unwrap_or(i64::MAX)
}

fn now_iso() -> String {
    crate::js_date::format_iso_millis(now_millis())
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned())
}
