//! Rebind one ranked result whenever its delivered evidence set changes.

use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
};

use crate::cognition::{
    CognitionResult, CognitionSourceRow,
    graph::{GraphRecallReader, RecallEpisodeRow, RecallMention, RelationshipState},
    recall::{RankedEpisode, RecallEvidence, RecallRequest, RecallResultChannel, RecallResultItem},
};

use super::{
    super::{evidence, selection::Selection},
    BoundCandidate,
};

/// One ranked episode and the pinned reads its result is built from.
pub(super) struct EpisodeBind<'a> {
    pub graph: &'a GraphRecallReader,
    pub input: &'a RecallRequest,
    pub selection: &'a Selection,
    pub ranked: &'a RankedEpisode,
    pub row: &'a RecallEpisodeRow,
    pub mentions: &'a [RecallMention],
    pub relationship: &'a RelationshipState,
    pub sources: &'a HashMap<&'a str, &'a CognitionSourceRow>,
    pub now_iso: &'a str,
}

/// The episode's result for the `delivered` evidence, or `None` when it has
/// no summary.
pub(super) fn bind(
    request: &EpisodeBind<'_>,
    delivered: &[RecallEvidence],
    parse_date: &dyn Fn(&str) -> f64,
) -> CognitionResult<Option<BoundCandidate>> {
    let EpisodeBind {
        graph,
        input,
        selection,
        row,
        ..
    } = *request;
    let surviving = delivered
        .iter()
        .filter_map(|item| evidence::raw_source_id(&item.source_ref))
        .collect::<HashSet<_>>();
    let matched = matched_node(request, &surviving);
    let interpreted = if row.has_claims {
        graph.matched_claim_summary(
            input,
            &row.episode_id,
            matched.as_deref(),
            request.mentions,
            &surviving,
        )?
    } else {
        None
    };
    let raw = delivered.iter().find(|item| {
        evidence::raw_source_id(&item.source_ref)
            .is_some_and(|id| selection.raw_source_ids.contains(&id))
    });
    let summary = interpreted
        .clone()
        .or_else(|| raw.map(|item| item.excerpt.clone()))
        .or_else(|| delivered.first().map(|item| item.excerpt.clone()));
    let Some(summary) = summary.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let refs = delivered
        .iter()
        .filter_map(|item| {
            evidence::raw_source_id(&item.source_ref).map(|id| (id, item.source_ref.clone()))
        })
        .collect::<Vec<_>>();
    let requirements = graph.result_requirements(input, &refs)?;
    let interpretations = graph.result_interpretations(input, &refs, parse_date)?;
    let historical = graph.historical_claim(input, &row.episode_id, request.now_iso, parse_date)?;
    let qualifications = qualifications(
        request,
        &surviving,
        Findings {
            historical,
            interpreted: interpreted.is_some(),
            raw_match: raw.is_some(),
        },
    );
    Ok(Some(BoundCandidate {
        item: RecallResultItem {
            episode_ref: row.episode_id.clone(),
            revision: row.revision.clone(),
            summary,
            occurred_at: row.event_at.clone(),
            conversation_at: row.conversation_at.clone(),
            channels: channels(request, &surviving),
            matched_node_ref: matched.clone(),
            association_path: matched
                .as_ref()
                .and_then(|id| selection.expansion.paths.get(id))
                .cloned()
                .unwrap_or_default(),
            evidence: delivered.to_vec(),
            requirements,
            interpretations,
            current_state_requires_verification: true,
            qualifications,
        },
    }))
}

/// The mentioned node the result is about: a non-supporting mention with
/// delivered evidence (reachable in the expansion for raw hits), preferring
/// the shortest path, then the highest relevance, then the lowest id.
fn matched_node(request: &EpisodeBind<'_>, surviving: &HashSet<String>) -> Option<String> {
    let selection = request.selection;
    let expansion = &selection.expansion;
    let path_len = |node: &str| expansion.paths.get(node).map_or(usize::MAX, Vec::len);
    let relevance = |node: &str| expansion.relevance.get(node).copied().unwrap_or(0.0);
    request
        .mentions
        .iter()
        .filter(|mention| {
            !mention.supports
                && (!selection.raw_episode_ids.contains(&request.row.episode_id)
                    || expansion.paths.contains_key(&mention.node_id))
                && surviving.contains(&mention.source_id)
        })
        .min_by(|a, b| {
            path_len(&a.node_id)
                .cmp(&path_len(&b.node_id))
                .then_with(|| {
                    relevance(&b.node_id)
                        .partial_cmp(&relevance(&a.node_id))
                        .unwrap_or(Ordering::Equal)
                })
                .then_with(|| a.node_id.as_bytes().cmp(b.node_id.as_bytes()))
        })
        .map(|mention| mention.node_id.clone())
}

/// The ranked channels, plus `explicit` when explicit records are admitted
/// and one of the delivered sources is an explicit rule.
fn channels(request: &EpisodeBind<'_>, surviving: &HashSet<String>) -> Vec<String> {
    let mut channels = request
        .ranked
        .channels
        .iter()
        .map(|channel| {
            match channel {
                RecallResultChannel::Graph => "graph",
                RecallResultChannel::Vector => "vector",
                RecallResultChannel::Lexical => "lexical",
                RecallResultChannel::Context => "context",
            }
            .to_owned()
        })
        .collect::<Vec<_>>();
    let explicit_hit = surviving
        .iter()
        .any(|id| request.relationship.explicit_rule_source_ids.contains(id));
    if request
        .input
        .admitted_channels
        .as_ref()
        .is_some_and(|channels| channels.explicit)
        && explicit_hit
    {
        channels.push("explicit".into());
    }
    channels
}

/// How a result's summary and evidence were found.
#[derive(Clone, Copy)]
struct Findings {
    /// The episode states a claim that is no longer current.
    historical: bool,
    /// The summary is the model's interpretation of a claim.
    interpreted: bool,
    /// A delivered source matched the raw lexical search.
    raw_match: bool,
}

/// `historical`, the relationship's qualifications, how the summary was
/// made, `raw_source_match`, and `uncertain` for an unknown-origin source.
fn qualifications(
    request: &EpisodeBind<'_>,
    surviving: &HashSet<String>,
    findings: Findings,
) -> Vec<String> {
    let Findings {
        historical,
        interpreted,
        raw_match,
    } = findings;
    let mut qualifications = Vec::new();
    if historical {
        qualifications.push("historical".into());
    }
    for value in &request.relationship.qualifications {
        if !qualifications.contains(value) {
            qualifications.push(value.clone());
        }
    }
    qualifications.push(
        if interpreted {
            "model_interpretation"
        } else {
            "unclassified_source"
        }
        .into(),
    );
    if raw_match {
        qualifications.push("raw_source_match".into());
    }
    if surviving.iter().any(|id| {
        request
            .sources
            .get(id.as_str())
            .is_some_and(|row| row.origin_kind == "unknown")
    }) {
        qualifications.push("uncertain".into());
    }
    qualifications
}
