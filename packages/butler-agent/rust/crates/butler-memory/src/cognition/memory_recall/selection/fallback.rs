//! Episode FTS is always a lexical candidate lane, fused with vectors when they
//! exist, so a partly embedded corpus never loses its text matches. Per hit only
//! cheap currency checks run; canonical spans are validated once for the selected
//! set, and stale hits refill without consuming quota.
use super::RecallSelectionInput;
use crate::cognition::{
    CognitionResult,
    sources::{RecallSourceHydration, RecallSourceResolution, hydrate_recall_sources},
};

/// Not superseded and every referenced source row still present; `None` past
/// the deadline.
fn current(
    request: &RecallSelectionInput<'_>,
    id: &str,
    refs: &str,
) -> CognitionResult<Option<bool>> {
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
    Ok(Some(request.graph.source_rows(&refs)?.len() == refs.len()))
}

/// Whether each selected hit's full canonical spans resolve, hydrated in one
/// pass; `None` when the deadline cut hydration short.
fn verify(
    request: &RecallSelectionInput<'_>,
    hits: &[(String, String)],
) -> CognitionResult<Option<Vec<bool>>> {
    let refs = hits
        .iter()
        .map(|(_, refs)| serde_json::from_str::<Vec<String>>(refs).unwrap_or_default())
        .collect::<Vec<_>>();
    let all = refs.iter().flatten().cloned().collect::<Vec<_>>();
    let rows = request.graph.source_rows(&all)?;
    let mut identities = Vec::with_capacity(hits.len());
    for (id, _) in hits {
        identities.extend(request.graph.episode_identity(id)?);
    }
    let resolved = hydrate_recall_sources(RecallSourceHydration {
        data_root: request.data_root,
        memory_root: request.memory_root,
        reader: request.canonical,
        rows: &rows,
        episodes: &identities,
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
    Ok(Some(
        refs.iter()
            .map(|ids| {
                ids.iter()
                    .all(|id| matches!(resolved.get(id), Some(RecallSourceResolution::Value(_))))
            })
            .collect(),
    ))
}

/// The episode FTS lane whenever the lexical channel is admitted, vectors or not.
pub(super) fn candidates(
    request: &RecallSelectionInput<'_>,
) -> CognitionResult<(Option<Vec<String>>, bool)> {
    if !request
        .input
        .admitted_channels
        .clone()
        .unwrap_or_default()
        .lexical
    {
        return Ok((None, false));
    }
    let (ids, partial) = request.graph.fts_candidates(
        request.input,
        |id, refs| current(request, id, refs),
        |hits| verify(request, hits),
    )?;
    Ok((Some(ids), partial))
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

/// Adds the FTS episodes and their mentions beside the vector episodes; the
/// lanes are fused in ranking, never one replacing the other.
pub(super) fn merge(
    request: &RecallSelectionInput<'_>,
    mut seeds: super::seeds::SeedGraph,
    fts: Option<Vec<String>>,
) -> CognitionResult<super::seeds::SeedGraph> {
    seeds.fts_searched = fts.is_some();
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
