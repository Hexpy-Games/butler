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

#[allow(clippy::too_many_arguments)]
pub(super) fn bind(
    graph: &GraphRecallReader,
    input: &RecallRequest,
    selection: &Selection,
    ranked: &RankedEpisode,
    row: &RecallEpisodeRow,
    mentions: &[RecallMention],
    relationship: &RelationshipState,
    sources: &HashMap<&str, &CognitionSourceRow>,
    _generation_id: &str,
    delivered: &[RecallEvidence],
    now_iso: &str,
    parse_date: &dyn Fn(&str) -> f64,
) -> CognitionResult<Option<BoundCandidate>> {
    let surviving = delivered
        .iter()
        .filter_map(|item| evidence::raw_source_id(&item.source_ref))
        .collect::<HashSet<_>>();
    let matched = mentions
        .iter()
        .filter(|mention| {
            !mention.supports
                && (!selection.raw_episode_ids.contains(&row.episode_id)
                    || selection.expansion.paths.contains_key(&mention.node_id))
                && surviving.contains(&mention.source_id)
        })
        .min_by(|a, b| {
            let left = selection
                .expansion
                .paths
                .get(&a.node_id)
                .map_or(usize::MAX, Vec::len);
            let right = selection
                .expansion
                .paths
                .get(&b.node_id)
                .map_or(usize::MAX, Vec::len);
            left.cmp(&right)
                .then_with(|| {
                    selection
                        .expansion
                        .relevance
                        .get(&b.node_id)
                        .copied()
                        .unwrap_or(0.0)
                        .partial_cmp(
                            &selection
                                .expansion
                                .relevance
                                .get(&a.node_id)
                                .copied()
                                .unwrap_or(0.0),
                        )
                        .unwrap_or(Ordering::Equal)
                })
                .then_with(|| a.node_id.as_bytes().cmp(b.node_id.as_bytes()))
        })
        .map(|mention| mention.node_id.clone());
    let interpreted = if row.has_claims {
        graph.matched_claim_summary(
            input,
            &row.episode_id,
            matched.as_deref(),
            mentions,
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
    let explicit_hit = surviving
        .iter()
        .any(|id| relationship.explicit_rule_source_ids.contains(id));
    let mut channels = ranked
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
    if input
        .admitted_channels
        .as_ref()
        .is_some_and(|channels| channels.explicit)
        && explicit_hit
    {
        channels.push("explicit".into());
    }
    let historical = graph.historical_claim(input, &row.episode_id, now_iso, parse_date)?;
    let mut qualifications = Vec::new();
    if historical {
        qualifications.push("historical".into());
    }
    for value in &relationship.qualifications {
        if !qualifications.contains(value) {
            qualifications.push(value.clone());
        }
    }
    qualifications.push(
        if interpreted.is_some() {
            "model_interpretation"
        } else {
            "unclassified_source"
        }
        .into(),
    );
    if raw.is_some() {
        qualifications.push("raw_source_match".into());
    }
    if surviving.iter().any(|id| {
        sources
            .get(id.as_str())
            .is_some_and(|row| row.origin_kind == "unknown")
    }) {
        qualifications.push("uncertain".into());
    }
    let item = RecallResultItem {
        episode_ref: row.episode_id.clone(),
        revision: row.revision.clone(),
        summary,
        occurred_at: row.event_at.clone(),
        conversation_at: row.conversation_at.clone(),
        channels,
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
    };
    Ok(Some(BoundCandidate { item }))
}
