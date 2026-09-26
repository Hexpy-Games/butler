//! Revalidate a metadata-only cursor against a fresh pinned graph snapshot.

mod result;

use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    path::Path,
};

use crate::cognition::{
    CognitionError, CognitionResult, CognitionSourceRow,
    feedback::{FeedbackSourceRow, excluded_source_ids},
    graph::{GraphRecallReader, RecallMention},
    recall::{RecallRequest, RecallResponse, RecallResultItem},
    sources::{RecallSourceHydration, RecallSourceResolution, hydrate_recall_sources},
};
use crate::conversation::ConversationSourceReader;

use super::{
    cursor::{CursorStore, Page},
    envelope,
};

#[allow(clippy::too_many_arguments)]
pub(super) fn run(
    graph: &GraphRecallReader,
    canonical: Option<&ConversationSourceReader>,
    source_root: &Path,
    memory_root: &Path,
    generation_id: &str,
    input: &RecallRequest,
    page: &Page,
    cursors: &CursorStore,
    deadline_at: i64,
    now_iso: &str,
    now_millis: &impl Fn() -> i64,
    parse_date: &impl Fn(&str) -> f64,
    compare_locale: &impl Fn(&str, &str) -> Ordering,
) -> CognitionResult<RecallResponse> {
    if graph.revision() != page.inventory.graph_revision {
        return Err(stale());
    }
    let slice_end = page
        .offset
        .saturating_add(input.limit)
        .min(page.inventory.candidates.len());
    let slice = page
        .inventory
        .candidates
        .get(page.offset..slice_end)
        .unwrap_or(&[]);
    let ids = slice
        .iter()
        .map(|item| item.episode_ref.clone())
        .collect::<Vec<_>>();
    let raw = slice
        .iter()
        .filter(|item| item.qualifications.iter().any(|q| q == "raw_source_match"))
        .map(|item| item.episode_ref.clone())
        .collect::<HashSet<_>>();
    let rows = graph
        .episode_rows(input, &ids, &raw)?
        .into_iter()
        .map(|row| (row.episode_id.clone(), row))
        .collect::<HashMap<_, _>>();
    let mut mentions = graph.mentions_for_episodes(input, &ids)?;
    mentions.extend(graph.episode_sources(input, &ids)?);
    let source_ids = mentions
        .iter()
        .map(|row| row.source_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let all_rows = graph.source_rows(&source_ids)?;
    let feedback = all_rows
        .iter()
        .map(|row| FeedbackSourceRow {
            source_id: &row.source_id,
            episode_id: &row.episode_id,
            revision: &row.revision,
            content_hash: &row.content_hash,
        })
        .collect::<Vec<_>>();
    let excluded = excluded_source_ids(
        &source_root.join("cognition/feedback"),
        &feedback,
        |operation| graph.quality_receipt_json(operation),
    )?;
    let projections = all_rows
        .into_iter()
        .filter(|row| !excluded.contains(&row.source_id))
        .collect::<Vec<CognitionSourceRow>>();
    let source_by_id = projections
        .iter()
        .map(|row| (row.source_id.as_str(), row))
        .collect::<HashMap<_, _>>();
    let episode_info = rows
        .values()
        .map(|row| crate::cognition::recall::RecallSourceEpisode {
            episode_id: row.episode_id.clone(),
            revision: row.revision.clone(),
            session_id: row.session_id.clone().unwrap_or_default(),
            turn_id: row.turn_id.clone(),
        })
        .collect::<Vec<_>>();
    let hydrated = hydrate_recall_sources(RecallSourceHydration {
        data_root: source_root,
        memory_root,
        reader: canonical,
        rows: &projections,
        episodes: &episode_info,
        max_graphemes: 480,
        deadline_at,
        now_millis,
        compare_locale,
    });
    let mut full = Vec::new();
    let mut offsets = Vec::new();
    let mut source_partial = false;
    for (index, metadata) in slice.iter().enumerate() {
        let Some(row) = rows
            .get(&metadata.episode_ref)
            .filter(|row| row.revision == metadata.revision)
        else {
            source_partial = true;
            continue;
        };
        let relationship = graph.relationship_state(input, &row.episode_id, now_iso)?;
        if relationship.superseded && !raw.contains(&row.episode_id) {
            source_partial = true;
            continue;
        }
        let episode_mentions = mentions
            .iter()
            .filter(|mention| mention.episode_id == row.episode_id)
            .cloned()
            .collect::<Vec<_>>();
        if episode_mentions.iter().any(|mention| {
            !matches!(
                hydrated.get(&mention.source_id),
                Some(RecallSourceResolution::Value(_))
            )
        }) {
            source_partial = true;
        }
        let candidate = result::bind(
            graph,
            input,
            generation_id,
            row,
            metadata,
            &episode_mentions,
            &relationship,
            &source_by_id,
            &hydrated,
            now_iso,
            parse_date,
        )?;
        match candidate {
            Some(item) => {
                full.push(item);
                offsets.push(index);
            }
            None => source_partial = true,
        }
    }
    let mut results = Vec::<RecallResultItem>::new();
    let mut included = Vec::new();
    let mut budget_trimmed = false;
    for (index, item) in full.iter().enumerate() {
        let minimum = envelope::minimum(
            item,
            |evidence| {
                let Some(row) = rows.get(&item.episode_ref) else {
                    return Err(CognitionError::new(
                        "memory_recall_unavailable",
                        "memory_recall_unavailable",
                    ));
                };
                let episode_mentions = mentions
                    .iter()
                    .filter(|m| m.episode_id == row.episode_id)
                    .cloned()
                    .collect::<Vec<RecallMention>>();
                result::rebind(
                    graph,
                    input,
                    row,
                    &episode_mentions,
                    item,
                    evidence,
                    parse_date,
                )
            },
            compare_locale,
        )?;
        results.push(minimum);
        included.push(offsets[index]);
        if envelope::bytes(&result::view(
            &page.inventory,
            &results,
            &page.key,
            page.offset,
            slice.len(),
            &included,
            source_partial,
            budget_trimmed,
        ))? > envelope::MAX_BYTES
        {
            results.pop();
            included.pop();
            budget_trimmed = true;
            if !results.is_empty() {
                break;
            }
        }
    }
    for (index, offset) in included.iter().copied().enumerate() {
        let Some(full_index) = offsets.iter().position(|value| *value == offset) else {
            continue;
        };
        let minimum = std::mem::replace(&mut results[index], full[full_index].clone());
        if envelope::bytes(&result::view(
            &page.inventory,
            &results,
            &page.key,
            page.offset,
            slice.len(),
            &included,
            source_partial,
            budget_trimmed,
        ))? > envelope::MAX_BYTES
        {
            results[index] = minimum;
        }
    }
    let response = result::view(
        &page.inventory,
        &results,
        &page.key,
        page.offset,
        slice.len(),
        &included,
        source_partial,
        budget_trimmed,
    )
    .into_owned();
    if response.next_cursor.is_none() {
        cursors.remove(&page.key)?;
    }
    Ok(response)
}

pub(super) fn stale() -> CognitionError {
    CognitionError::new("stale_cursor", "stale_cursor")
}
