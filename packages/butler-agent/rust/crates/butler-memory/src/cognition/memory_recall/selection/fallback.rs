//! Validate full canonical spans before FTS top-k; stale hits do not consume quota.
use super::RecallSelectionInput;
use crate::cognition::{
    CognitionResult,
    sources::{RecallSourceHydration, RecallSourceResolution, hydrate_recall_sources},
};

fn select(request: &RecallSelectionInput<'_>) -> CognitionResult<(Vec<String>, bool)> {
    request.graph.fts_candidates(request.input, |id, refs| {
        if (request.now_millis)() >= request.candidate_deadline {
            return Ok(None);
        }
        if request
            .graph
            .relationship_state(request.input, id, request.now_iso)?
            .superseded
        {
            return Ok(Some(false));
        }
        let refs: Vec<String> = serde_json::from_str(refs).unwrap_or_default();
        if refs.is_empty() {
            return Ok(Some(false));
        }
        let rows = request.graph.source_rows(&refs)?;
        if rows.len() != refs.len() {
            return Ok(Some(false));
        }
        let identity = request
            .graph
            .episode_identity(id)?
            .into_iter()
            .collect::<Vec<_>>();
        let resolved = hydrate_recall_sources(RecallSourceHydration {
            data_root: request.data_root,
            memory_root: request.memory_root,
            reader: request.canonical,
            rows: &rows,
            episodes: &identity,
            max_graphemes: usize::MAX,
            deadline_at: request.candidate_deadline,
            now_millis: request.now_millis,
            compare_locale: request.compare_locale,
        });
        if resolved
            .values()
            .any(|value| matches!(value, RecallSourceResolution::Deadline))
        {
            return Ok(None);
        }
        Ok(Some(refs.iter().all(|id| {
            matches!(resolved.get(id), Some(RecallSourceResolution::Value(_)))
        })))
    })
}

pub(super) fn candidates(
    request: &RecallSelectionInput<'_>,
) -> CognitionResult<(Option<Vec<String>>, bool)> {
    if request
        .input
        .admitted_channels
        .clone()
        .unwrap_or_default()
        .lexical
        && (request.vector_matches.is_none()
            || !request.graph.compatible_vectors(request.generation)?)
    {
        let (ids, partial) = select(request)?;
        Ok((Some(ids), partial))
    } else {
        Ok((None, false))
    }
}

pub(super) fn coverage(
    mut semantic: crate::cognition::recall::SemanticSelection,
    partial: bool,
) -> crate::cognition::recall::SemanticSelection {
    if partial {
        semantic.coverage_codes.push("episode_fts_pending".into());
    }
    semantic
}

pub(super) fn merge(
    request: &RecallSelectionInput<'_>,
    mut seeds: super::seeds::SeedGraph,
    fts: Option<Vec<String>>,
) -> CognitionResult<super::seeds::SeedGraph> {
    seeds.fts_searched = fts.is_some();
    if seeds.fts_searched {
        seeds.vector_episodes.clear();
        seeds.vector_searched = false;
    }
    let fts = fts.unwrap_or_default();
    seeds
        .mentions
        .extend(request.graph.mentions_for_episodes(request.input, &fts)?);
    seeds
        .mentions
        .extend(request.graph.episode_sources(request.input, &fts)?);
    let mut seen = std::collections::HashSet::new();
    seeds
        .mentions
        .retain(|m| seen.insert((m.source_id.clone(), m.node_id.clone())));
    seeds.fts_episodes = fts;
    Ok(seeds)
}
