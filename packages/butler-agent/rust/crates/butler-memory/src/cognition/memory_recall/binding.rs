//! Original-source hydration and ordered evidence selection under one graph pin.
//!
//! [`run`] loads the current (not feedback-excluded) sources of every ranked
//! episode, hydrates their original text once, and binds each episode to at
//! most three delivered evidence items (raw hits first, then by priority,
//! basis, recency and id).

mod result;

use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    path::Path,
};

use crate::cognition::{
    CognitionResult, CognitionSourceRow,
    feedback::{FeedbackSourceRow, excluded_source_ids},
    graph::{GraphRecallReader, RecallEpisodeRow, RecallMention, RelationshipState},
    recall::{
        RecallEvidence, RecallEvidenceRelation, RecallEvidenceSupport, RecallReadArgs,
        RecallRequest, RecallResultItem, RecallSourceEpisode, RecallSourceKind,
    },
    sources::{
        RecallSourceHydration, RecallSourceResolution, ResolvedRecallSource, hydrate_recall_sources,
    },
};
use butler_turn::conversation::ConversationSourceReader;

use super::{Clocks, evidence, selection::Selection};
use result::EpisodeBind;

#[derive(Clone)]
pub(super) struct BoundCandidate {
    pub item: RecallResultItem,
}

/// Bound results and what source hydration reported.
pub(super) struct Binding {
    pub candidates: Vec<BoundCandidate>,
    pub source_rows: HashMap<String, CognitionSourceRow>,
    pub failed_sources: HashSet<String>,
    pub source_deadline_hit: bool,
    pub hydrated_count: usize,
}

/// The pinned reads a first page binds from.
#[derive(Clone, Copy)]
pub(super) struct BindingInput<'a> {
    pub graph: &'a GraphRecallReader,
    pub canonical: Option<&'a ConversationSourceReader>,
    pub data_root: &'a Path,
    pub memory_root: &'a Path,
    pub generation_id: &'a str,
    pub input: &'a RecallRequest,
    pub selection: &'a Selection,
    pub deadline_at: i64,
    pub now_iso: &'a str,
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

/// Binds every ranked episode; `on_hydrated` runs once sources are hydrated.
pub(super) fn run(
    request: &BindingInput<'_>,
    clocks: Clocks<'_>,
    on_hydrated: impl FnOnce(),
) -> CognitionResult<Binding> {
    let BindingInput {
        graph,
        input,
        selection,
        ..
    } = *request;
    let rows = current_source_rows(graph, request.data_root, &source_ids(selection))?;
    let hydrated = hydrate(request, &rows, &clocks);
    on_hydrated();
    let source_by_id = rows
        .iter()
        .map(|row| (row.source_id.as_str(), row))
        .collect::<HashMap<_, _>>();
    let mut output = Binding {
        candidates: Vec::new(),
        source_rows: HashMap::new(),
        failed_sources: HashSet::new(),
        source_deadline_hit: false,
        hydrated_count: hydrated
            .values()
            .filter(|value| matches!(value, RecallSourceResolution::Value(_)))
            .count(),
    };
    let delivery = Delivery {
        request,
        hydrated: &hydrated,
        sources: &source_by_id,
        raw_phrases: std::iter::once(input.cue.clone())
            .chain(input.seed_phrases.iter().cloned())
            .collect(),
        parse_date: clocks.parse_date,
    };
    for ranked in &selection.ranked {
        let episode = &ranked.input.episode_id;
        let (Some(mentions), Some(row), Some(relationship)) = (
            selection.mentions.get(episode),
            selection.rows.get(episode),
            selection.relationships.get(episode),
        ) else {
            continue;
        };
        let evidence = delivery.evidence(mentions, relationship, &mut output);
        if evidence.is_empty() {
            continue;
        }
        let bind = EpisodeBind {
            graph,
            input,
            selection,
            ranked,
            row,
            mentions,
            relationship,
            sources: &source_by_id,
            now_iso: request.now_iso,
        };
        if let Some(candidate) = result::bind(&bind, &evidence, clocks.parse_date)? {
            output.candidates.push(candidate);
        }
    }
    output.source_rows = rows
        .into_iter()
        .map(|row| (row.source_id.clone(), row))
        .collect();
    Ok(output)
}

/// The current text of `rows` and of the selected episodes, hydrated up to
/// the request deadline.
fn hydrate(
    request: &BindingInput<'_>,
    rows: &[CognitionSourceRow],
    clocks: &Clocks<'_>,
) -> HashMap<String, RecallSourceResolution> {
    let episodes = source_episodes(request.selection.rows.values());
    hydrate_recall_sources(RecallSourceHydration {
        data_root: request.data_root,
        memory_root: request.memory_root,
        reader: request.canonical,
        rows,
        episodes: &episodes,
        max_graphemes: 480,
        deadline_at: request.deadline_at,
        now_millis: clocks.now_millis,
        compare_locale: clocks.compare_locale,
    })
}

/// Every distinct source mentioned by a ranked episode, in rank order.
fn source_ids(selection: &Selection) -> Vec<String> {
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    for ranked in &selection.ranked {
        let Some(mentions) = selection.mentions.get(&ranked.input.episode_id) else {
            continue;
        };
        for mention in mentions {
            if seen.insert(mention.source_id.clone()) {
                ids.push(mention.source_id.clone());
            }
        }
    }
    ids
}

/// The source rows of `ids` that quality feedback under `data_root` did not
/// exclude.
pub(super) fn current_source_rows(
    graph: &GraphRecallReader,
    data_root: &Path,
    ids: &[String],
) -> CognitionResult<Vec<CognitionSourceRow>> {
    let all_rows = graph.source_rows(ids)?;
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
    Ok(all_rows
        .into_iter()
        .filter(|row| !excluded.contains(&row.source_id))
        .collect())
}

/// The episode identities hydration checks sources against.
pub(super) fn source_episodes<'a>(
    rows: impl Iterator<Item = &'a RecallEpisodeRow>,
) -> Vec<RecallSourceEpisode> {
    rows.map(|row| RecallSourceEpisode {
        episode_id: row.episode_id.clone(),
        revision: row.revision.clone(),
        session_id: row.session_id.clone().unwrap_or_default(),
        turn_id: row.turn_id.clone(),
    })
    .collect()
}

/// What choosing an episode's evidence reads.
struct Delivery<'a> {
    request: &'a BindingInput<'a>,
    hydrated: &'a HashMap<String, RecallSourceResolution>,
    sources: &'a HashMap<&'a str, &'a CognitionSourceRow>,
    raw_phrases: Vec<String>,
    parse_date: &'a dyn Fn(&str) -> f64,
}

impl Delivery<'_> {
    /// Up to three hydrated sources of the episode, raw hits first; records
    /// failed and deadline-cut sources in `output`.
    fn evidence(
        &self,
        mentions: &[RecallMention],
        relationship: &RelationshipState,
        output: &mut Binding,
    ) -> Vec<RecallEvidence> {
        let selection = self.request.selection;
        let mut available = Vec::new();
        for mention in mentions {
            match self.hydrated.get(&mention.source_id) {
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
                        self.sources.get(a.source_id.as_str()).copied(),
                        self.sources.get(b.source_id.as_str()).copied(),
                        &relationship.priority_source_ids,
                        self.parse_date,
                    )
                })
        });
        let mut evidence = Vec::<RecallEvidence>::new();
        let mut included = HashSet::new();
        for mention in available {
            if !included.insert(mention.source_id.as_str()) {
                continue;
            }
            let Some(RecallSourceResolution::Value(source)) = self.hydrated.get(&mention.source_id)
            else {
                continue;
            };
            evidence.push(self.item(mention, source));
            if evidence.len() >= 3 {
                break;
            }
        }
        evidence
    }

    /// One delivered source: a raw hit shows the excerpt around its matched
    /// phrase, other sources their stored excerpt.
    fn item(&self, mention: &RecallMention, source: &ResolvedRecallSource) -> RecallEvidence {
        let input = self.request.input;
        let source_ref = evidence::handle(self.request.generation_id, &source.source_ref);
        let excerpt = if self
            .request
            .selection
            .raw_source_ids
            .contains(&mention.source_id)
        {
            evidence::raw_excerpt(source.text(), &self.raw_phrases, 480)
        } else {
            source.excerpt.clone()
        };
        RecallEvidence {
            source_ref: source_ref.clone(),
            basis: source.basis.clone(),
            excerpt,
            source_resolved: true,
            conversation_session_id: source.conversation_session_id.clone(),
            conversation_message_id: source.conversation_message_id.clone(),
            source_kind: source_kind(&source.source_kind),
            support: support(mention),
            read_args: read_args(input, source_ref),
        }
    }
}

/// Rebinds a first-page result to a smaller evidence set.
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
    let (Some(row), Some(mentions), Some(relationship)) = (
        selection.rows.get(episode),
        selection.mentions.get(episode),
        selection.relationships.get(episode),
    ) else {
        return Ok(None);
    };
    let sources = binding
        .source_rows
        .iter()
        .map(|(id, row)| (id.as_str(), row))
        .collect();
    let bind = EpisodeBind {
        graph,
        input,
        selection,
        ranked,
        row,
        mentions,
        relationship,
        sources: &sources,
        now_iso,
    };
    result::bind(&bind, &evidence, parse_date).map(|value| value.map(|candidate| candidate.item))
}

/// How the delivered source relates to the mentioned node.
pub(super) fn support(mention: &RecallMention) -> RecallEvidenceSupport {
    RecallEvidenceSupport {
        node_ref: mention.node_id.clone(),
        relation: if mention.supports {
            RecallEvidenceRelation::Supports
        } else {
            RecallEvidenceRelation::Mentions
        },
    }
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

/// Source order within an episode: relationship priority, then basis (user,
/// reviewed task, assistant, other), then newest first, then source id.
pub(super) fn compare_handles(
    left: Option<&CognitionSourceRow>,
    right: Option<&CognitionSourceRow>,
    priority: &HashSet<String>,
    parse_date: &dyn Fn(&str) -> f64,
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
