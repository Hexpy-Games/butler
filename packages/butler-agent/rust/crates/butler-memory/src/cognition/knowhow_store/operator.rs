//! Operator commands over KnowHow: list, show, disable, retrieve, source
//! quality and index rebuild.

use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::Value;

use crate::cognition::{CognitionResult, FeedbackTarget};

use super::document::{KnowHowDocument, KnowHowEntry, round3};
use super::{KnowHowAggregateReport, KnowHowService, entries, error, quality};
use crate::cognition::CognitionCode;
use crate::lenient::{Arg, Obj};

/// `knowhow rebuild-index`: what was indexed and where.
#[derive(Serialize)]
struct RebuildReport {
    indexed_count: usize,
    source_quality_count: usize,
    index_path: String,
}

/// One scored entry of `knowhow retrieve`.
#[derive(Serialize)]
struct RetrievalCandidate {
    entry: KnowHowDocument,
    match_score: f64,
    quality_score: f64,
    final_score: f64,
    suppressed_by_feedback_ids: Vec<String>,
}

/// `knowhow retrieve`: the best unsuppressed candidate and every candidate.
#[derive(Serialize)]
struct Retrieval<'a> {
    query: &'a str,
    selected: Option<&'a KnowHowDocument>,
    candidates: &'a [RetrievalCandidate],
}

impl KnowHowService {
    /// Every entry, newest first.
    pub async fn operator_entries(&self) -> CognitionResult<Vec<Value>> {
        self.with_lease("knowhow_operator_list", |root| {
            Ok(list(&root)?
                .into_iter()
                .map(KnowHowDocument::into_value)
                .collect())
        })
        .await
    }

    /// The entry `id`, or `None` when it does not exist.
    pub async fn operator_read(&self, id: &str) -> CognitionResult<Option<Value>> {
        let id = id.to_owned();
        self.with_lease("knowhow_operator_show", move |root| {
            Ok(entries::read_id(&root, &id)?.map(KnowHowDocument::into_value))
        })
        .await
    }

    /// Disables the entry `id` and returns it.
    pub async fn operator_disable(&self, id: &str) -> CognitionResult<Option<Value>> {
        let id = id.to_owned();
        self.with_lease("knowhow_operator_disable", move |root| disable(&root, &id))
            .await
    }

    /// Entries matching `query`, scored and suppressed by active feedback.
    pub async fn operator_retrieve(
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

    /// The aggregated source-quality summaries.
    pub async fn operator_source_quality(&self) -> CognitionResult<Vec<Value>> {
        self.with_lease("knowhow_operator_quality", |root| {
            quality::aggregate(&root)?.iter().map(encode).collect()
        })
        .await
    }

    /// Rebuilds the index and reports it.
    pub async fn operator_rebuild_index(&self) -> CognitionResult<Value> {
        let report: KnowHowAggregateReport = self.aggregate_and_rebuild().await?;
        let index_path = self
            .paths
            .cognition_root(&self.data_root)
            .join("know-how/index.sqlite");
        encode(&RebuildReport {
            indexed_count: report.knowhow_indexed_count,
            source_quality_count: report.source_quality_summary_count,
            index_path: index_path.to_string_lossy().into_owned(),
        })
    }
}

pub(super) fn list(root: &Path) -> CognitionResult<Vec<KnowHowDocument>> {
    entries::list_paths(root)?
        .iter()
        .map(|path| entries::read_one(root, path))
        .collect()
}

pub(super) fn disable(root: &Path, id: &str) -> CognitionResult<Option<Value>> {
    let Some(mut document) = entries::read_id(root, id)? else {
        return Ok(None);
    };
    let entry = document.entry();
    let previous_status = entry.status.valid().cloned();
    let now = now_iso();
    document.set_status("disabled", &now)?;
    let previous_status =
        previous_status.ok_or_else(|| error(CognitionCode::MemoryKnowhowEntryInvalid))?;
    document.push_history("operator_disable", None, &previous_status, now_iso())?;
    entries::write(root, &document)?;
    Ok(Some(document.into_value()))
}

pub(super) fn retrieve(
    root: &Path,
    query: &str,
    limit: usize,
    feedback: &[FeedbackTarget],
) -> CognitionResult<Value> {
    let normalized_query = normalize(query);
    let query_tokens = tokenize(&normalized_query);
    let mut candidates = list(root)?
        .into_iter()
        .filter(|document| {
            matches!(
                document.entry().status.valid().map(String::as_str),
                Some("active" | "candidate" | "needs_review")
            )
        })
        .map(|document| candidate(document, &normalized_query, &query_tokens, feedback))
        .collect::<CognitionResult<Vec<_>>>()?;
    candidates.retain(|candidate| candidate.match_score > 0.0);
    candidates.sort_by(|left, right| right.final_score.total_cmp(&left.final_score));
    candidates.truncate(limit);
    let selected = candidates
        .iter()
        .find(|candidate| candidate.final_score > 0.0)
        .map(|candidate| &candidate.entry);
    encode(&Retrieval {
        query,
        selected,
        candidates: &candidates,
    })
}

/// An entry's match, quality and final score; feedback aimed at the entry
/// or its sources in a policy/quality/know-how category suppresses it.
fn candidate(
    document: KnowHowDocument,
    query: &str,
    query_tokens: &[String],
    feedback: &[FeedbackTarget],
) -> CognitionResult<RetrievalCandidate> {
    let entry = document.entry();
    let match_score = match_score(&entry, query, query_tokens)?;
    let id = KnowHowEntry::required(&entry.knowhow_id)?;
    let Arg::Valid(Obj(strategy)) = &entry.strategy else {
        return Err(error(CognitionCode::MemoryKnowhowEntryInvalid));
    };
    let preferred_sources = strategy
        .preferred_sources
        .valid()
        .ok_or_else(|| error(CognitionCode::MemoryKnowhowEntryInvalid))?;
    let suppressed = feedback
        .iter()
        .filter(|feedback| {
            feedback.target_ref == format!("knowhow:{id}")
                || preferred_sources.iter().any(|source| {
                    source
                        .valid()
                        .is_some_and(|source| feedback.target_ref == format!("source:{source}"))
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
        .quality()
        .ok()
        .and_then(|quality| quality.score.valid().copied())
        .ok_or_else(|| error(CognitionCode::MemoryKnowhowEntryInvalid))?;
    let final_score = if suppressed.is_empty() {
        round3(match_score * 0.65 + quality_score * 0.35)
    } else {
        0.0
    };
    Ok(RetrievalCandidate {
        entry: document,
        match_score,
        quality_score,
        final_score,
        suppressed_by_feedback_ids: suppressed,
    })
}

/// The best weighted match of the query against the entry's name (1.0),
/// aliases (0.95), topics (0.8), examples (0.65) and summary (0.35): a
/// substring match counts fully, a token overlap proportionally.
fn match_score(entry: &KnowHowEntry, query: &str, query_tokens: &[String]) -> CognitionResult<f64> {
    let required = KnowHowEntry::required;
    let name = required(&entry.name)?;
    let aliases = KnowHowEntry::strings(&entry.aliases)?;
    let (topics, examples) = match &entry.intent_match {
        Arg::Valid(Obj(intent)) => (
            KnowHowEntry::strings(&intent.topics)?,
            KnowHowEntry::strings(&intent.examples)?,
        ),
        _ => return Err(error(CognitionCode::MemoryKnowhowEntryInvalid)),
    };
    let summary = required(&entry.summary)?;
    let buckets = std::iter::once((name, 1.0))
        .chain(aliases.iter().map(|value| (*value, 0.95)))
        .chain(topics.iter().map(|value| (*value, 0.8)))
        .chain(examples.iter().map(|value| (*value, 0.65)))
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

fn encode(value: &impl Serialize) -> CognitionResult<Value> {
    serde_json::to_value(value)
        .map_err(|source| error(CognitionCode::MemoryKnowhowEntryInvalid).with_source(source))
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
    butler_core::js_date::format_iso_millis(now_millis())
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned())
}
