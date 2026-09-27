//! Original-source hydration and ordered evidence selection under one graph pin.

mod result;

use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    path::Path,
};

use crate::cognition::{
    CognitionResult, CognitionSourceRow,
    feedback::{FeedbackSourceRow, excluded_source_ids},
    graph::GraphRecallReader,
    recall::{
        RecallEvidence, RecallEvidenceRelation, RecallEvidenceSupport, RecallReadArgs,
        RecallRequest, RecallResultItem, RecallSourceEpisode, RecallSourceKind,
    },
    sources::{RecallSourceHydration, RecallSourceResolution, hydrate_recall_sources},
};
use crate::conversation::ConversationSourceReader;

use super::{evidence, selection::Selection};

#[derive(Clone)]
pub(super) struct BoundCandidate {
    pub item: RecallResultItem,
}

pub(super) struct Binding {
    pub candidates: Vec<BoundCandidate>,
    pub source_rows: HashMap<String, CognitionSourceRow>,
    pub failed_sources: HashSet<String>,
    pub source_deadline_hit: bool,
    pub hydrated_count: usize,
}

pub(super) struct RecallRebindInput<'a> {
    pub graph: &'a GraphRecallReader,
    pub input: &'a RecallRequest,
    pub selection: &'a Selection,
    pub binding: &'a Binding,
    pub original: &'a RecallResultItem,
    pub evidence: Vec<RecallEvidence>,
    pub now_iso: &'a str,
    pub parse_date: &'a dyn Fn(&str) -> f64,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn run(
    graph: &GraphRecallReader,
    canonical: Option<&ConversationSourceReader>,
    data_root: &Path,
    memory_root: &Path,
    generation_id: &str,
    input: &RecallRequest,
    selection: &Selection,
    deadline_at: i64,
    now_iso: &str,
    now_millis: &impl Fn() -> i64,
    parse_date: &impl Fn(&str) -> f64,
    compare_locale: &impl Fn(&str, &str) -> Ordering,
    on_hydrated: impl FnOnce(),
) -> CognitionResult<Binding> {
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    for ranked in &selection.ranked {
        if let Some(mentions) = selection.mentions.get(&ranked.input.episode_id) {
            for mention in mentions {
                if seen.insert(mention.source_id.clone()) {
                    ids.push(mention.source_id.clone());
                }
            }
        }
    }
    let all_rows = graph.source_rows(&ids)?;
    let feedback_rows = all_rows
        .iter()
        .map(|row| FeedbackSourceRow {
            source_id: &row.source_id,
            episode_id: &row.episode_id,
            revision: &row.revision,
            content_hash: &row.content_hash,
        })
        .collect::<Vec<_>>();
    let excluded = excluded_source_ids(
        &data_root.join("cognition/feedback"),
        &feedback_rows,
        |operation| graph.quality_receipt_json(operation),
    )?;
    let rows = all_rows
        .into_iter()
        .filter(|row| !excluded.contains(&row.source_id))
        .collect::<Vec<_>>();
    let source_by_id = rows
        .iter()
        .map(|row| (row.source_id.as_str(), row))
        .collect::<HashMap<_, _>>();
    let episodes = selection
        .rows
        .values()
        .map(|row| RecallSourceEpisode {
            episode_id: row.episode_id.clone(),
            revision: row.revision.clone(),
            session_id: row.session_id.clone().unwrap_or_default(),
            turn_id: row.turn_id.clone(),
        })
        .collect::<Vec<_>>();
    let hydrated = hydrate_recall_sources(RecallSourceHydration {
        data_root,
        memory_root,
        reader: canonical,
        rows: &rows,
        episodes: &episodes,
        max_graphemes: 480,
        deadline_at,
        now_millis,
        compare_locale,
    });
    on_hydrated();
    let hydrated_count = hydrated
        .values()
        .filter(|value| matches!(value, RecallSourceResolution::Value(_)))
        .count();
    let raw_phrases = std::iter::once(input.cue.clone())
        .chain(input.seed_phrases.iter().cloned())
        .collect::<Vec<_>>();
    let mut output = Binding {
        candidates: Vec::new(),
        source_rows: HashMap::new(),
        failed_sources: HashSet::new(),
        source_deadline_hit: false,
        hydrated_count,
    };
    for ranked in &selection.ranked {
        let Some(mentions) = selection.mentions.get(&ranked.input.episode_id) else {
            continue;
        };
        let Some(row) = selection.rows.get(&ranked.input.episode_id) else {
            continue;
        };
        let Some(relationship) = selection.relationships.get(&ranked.input.episode_id) else {
            continue;
        };
        let mut available = Vec::new();
        for mention in mentions {
            match hydrated.get(&mention.source_id) {
                Some(RecallSourceResolution::Value(_)) => available.push(mention),
                Some(RecallSourceResolution::Deadline) => output.source_deadline_hit = true,
                _ => {
                    output.failed_sources.insert(mention.source_id.clone());
                }
            }
        }
        available.sort_by(|a, b| {
            selection
                .raw_source_ids
                .contains(&b.source_id)
                .cmp(&selection.raw_source_ids.contains(&a.source_id))
                .then_with(|| {
                    compare_handles(
                        source_by_id.get(a.source_id.as_str()).copied(),
                        source_by_id.get(b.source_id.as_str()).copied(),
                        &relationship.priority_source_ids,
                        parse_date,
                    )
                })
        });
        let mut evidence = Vec::<RecallEvidence>::new();
        let mut included = HashSet::new();
        for mention in available {
            if !included.insert(mention.source_id.as_str()) {
                continue;
            }
            let Some(RecallSourceResolution::Value(source)) = hydrated.get(&mention.source_id)
            else {
                continue;
            };
            let source_ref = evidence::handle(generation_id, &source.source_ref);
            let excerpt = if selection.raw_source_ids.contains(&mention.source_id) {
                evidence::raw_excerpt(source.text(), &raw_phrases, 480)
            } else {
                source.excerpt.clone()
            };
            evidence.push(RecallEvidence {
                source_ref: source_ref.clone(),
                basis: source.basis.clone(),
                excerpt,
                source_resolved: true,
                conversation_session_id: source.conversation_session_id.clone(),
                conversation_message_id: source.conversation_message_id.clone(),
                source_kind: source_kind(&source.source_kind),
                support: RecallEvidenceSupport {
                    node_ref: mention.node_id.clone(),
                    relation: if mention.supports {
                        RecallEvidenceRelation::Supports
                    } else {
                        RecallEvidenceRelation::Mentions
                    },
                },
                read_args: read_args(input, source_ref),
            });
            if evidence.len() >= 3 {
                break;
            }
        }
        if evidence.is_empty() {
            continue;
        }
        if let Some(candidate) = result::bind(
            graph,
            input,
            selection,
            ranked,
            row,
            mentions,
            relationship,
            &source_by_id,
            generation_id,
            &evidence,
            now_iso,
            parse_date,
        )? {
            output.candidates.push(candidate);
        }
    }
    output.source_rows = rows
        .into_iter()
        .map(|row| (row.source_id.clone(), row))
        .collect();
    Ok(output)
}

pub(super) fn rebind(request: RecallRebindInput<'_>) -> CognitionResult<Option<RecallResultItem>> {
    let RecallRebindInput {
        graph,
        input,
        selection,
        binding,
        original,
        evidence,
        now_iso,
        parse_date,
    } = request;
    let episode = &original.episode_ref;
    let Some(ranked) = selection
        .ranked
        .iter()
        .find(|item| item.input.episode_id == *episode)
    else {
        return Ok(None);
    };
    let Some(row) = selection.rows.get(episode) else {
        return Ok(None);
    };
    let Some(mentions) = selection.mentions.get(episode) else {
        return Ok(None);
    };
    let Some(relationship) = selection.relationships.get(episode) else {
        return Ok(None);
    };
    let sources = binding
        .source_rows
        .iter()
        .map(|(id, row)| (id.as_str(), row))
        .collect();
    result::bind(
        graph,
        input,
        selection,
        ranked,
        row,
        mentions,
        relationship,
        &sources,
        "",
        &evidence,
        now_iso,
        parse_date,
    )
    .map(|value| value.map(|candidate| candidate.item))
}

pub(super) fn source_kind(value: &str) -> Option<RecallSourceKind> {
    match value {
        "conversation" => Some(RecallSourceKind::Conversation),
        "task_report" => Some(RecallSourceKind::TaskReport),
        "explicit_record" => Some(RecallSourceKind::ExplicitRecord),
        _ => None,
    }
}

pub(super) fn read_args(input: &RecallRequest, source_ref: String) -> RecallReadArgs {
    RecallReadArgs {
        scope: input.scope,
        source_ref,
        max_chars: 12_000,
        session_ids: (!input.session_ids.is_empty()).then(|| input.session_ids.clone()),
        project_filter: (input.project_filter
            != crate::cognition::recall::RecallProjectFilter::Any)
            .then_some(input.project_filter),
        project_ids: (!input.project_ids.is_empty()).then(|| input.project_ids.clone()),
        include_internal: input.include_internal.then_some(true),
    }
}

pub(super) fn compare_handles(
    left: Option<&CognitionSourceRow>,
    right: Option<&CognitionSourceRow>,
    priority: &HashSet<String>,
    parse_date: &impl Fn(&str) -> f64,
) -> Ordering {
    let priority_of =
        |row: Option<&CognitionSourceRow>| row.is_some_and(|row| priority.contains(&row.source_id));
    let basis = |row: Option<&CognitionSourceRow>| match row.map(|row| row.basis.as_str()) {
        Some("user_statement") => 0,
        Some("reviewed_task") => 1,
        Some("assistant_statement") => 2,
        _ => 3,
    };
    priority_of(right)
        .cmp(&priority_of(left))
        .then_with(|| basis(left).cmp(&basis(right)))
        .then_with(|| {
            let left = parse_date(left.map_or("", |row| &row.observed_at));
            let right = parse_date(right.map_or("", |row| &row.observed_at));
            (right - left).partial_cmp(&0.0).unwrap_or(Ordering::Equal)
        })
        .then_with(|| {
            left.map_or("", |row| row.source_id.as_str())
                .as_bytes()
                .cmp(right.map_or("", |row| row.source_id.as_str()).as_bytes())
        })
}
