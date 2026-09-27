//! Revalidate a metadata-only cursor against a fresh pinned graph snapshot.
//!
//! [`run`] reloads the page's episodes and sources from the current graph,
//! rebinds every candidate whose revision still matches, then fits the page
//! into the envelope: minimum bundles first, then full bundles where they fit.

mod result;

use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use crate::cognition::{
    CognitionError, CognitionResult, CognitionSourceRow,
    graph::{GraphRecallReader, RecallEpisodeRow, RecallMention},
    recall::{RecallRequest, RecallResponse, RecallResultItem},
    sources::{RecallSourceHydration, RecallSourceResolution, hydrate_recall_sources},
};
use butler_turn::conversation::ConversationSourceReader;

use super::{
    Clocks, binding,
    cursor::{Candidate, CursorStore, Page},
    envelope,
};
use crate::cognition::CognitionCode;
use result::{BindInput, Delivery, PageFrame};

/// What one continuation reads.
#[derive(Clone, Copy)]
pub(super) struct ContinuationInput<'a> {
    pub graph: &'a GraphRecallReader,
    pub canonical: Option<&'a ConversationSourceReader>,
    pub source_root: &'a Path,
    pub memory_root: &'a Path,
    pub generation_id: &'a str,
    pub input: &'a RecallRequest,
    pub page: &'a Page,
    pub deadline_at: i64,
    pub now_iso: &'a str,
}

/// The page's episodes and their current, not-excluded, hydrated sources.
struct PageSources {
    rows: HashMap<String, RecallEpisodeRow>,
    raw: HashSet<String>,
    mentions: Vec<RecallMention>,
    projections: Vec<CognitionSourceRow>,
    hydrated: HashMap<String, RecallSourceResolution>,
}

/// Candidates rebound on the fresh snapshot, with their page offsets.
struct Bound {
    full: Vec<RecallResultItem>,
    offsets: Vec<usize>,
    source_partial: bool,
}

/// Minimum bundles that fit the envelope, with their page offsets.
struct Fitted {
    results: Vec<RecallResultItem>,
    included: Vec<usize>,
    budget_trimmed: bool,
}

pub(super) fn run(
    request: ContinuationInput<'_>,
    cursors: &CursorStore,
    clocks: Clocks<'_>,
) -> CognitionResult<RecallResponse> {
    let page = request.page;
    if request.graph.revision() != page.inventory.graph_revision {
        return Err(stale());
    }
    let slice_end = page
        .offset
        .saturating_add(request.input.limit)
        .min(page.inventory.candidates.len());
    let slice = page
        .inventory
        .candidates
        .get(page.offset..slice_end)
        .unwrap_or(&[]);
    let sources = PageSources::load(&request, slice, clocks)?;
    let bound = bind_page(&request, slice, &sources, clocks)?;
    let frame = PageFrame {
        inventory: &page.inventory,
        key: &page.key,
        offset: page.offset,
        page_len: slice.len(),
    };
    let fitted = fit_minimum(&request, &frame, &sources, &bound, clocks)?;
    let delivery = Delivery {
        included: &fitted.included,
        source_partial: bound.source_partial,
        budget_trimmed: fitted.budget_trimmed,
    };
    let results = upgrade_to_full(&frame, fitted.results, &delivery, &bound)?;
    let response = result::view(&frame, &results, &delivery).into_owned();
    if response.next_cursor.is_none() {
        cursors.remove(&page.key);
    }
    Ok(response)
}

impl PageSources {
    fn load(
        request: &ContinuationInput<'_>,
        slice: &[Candidate],
        clocks: Clocks<'_>,
    ) -> CognitionResult<Self> {
        let (graph, input) = (request.graph, request.input);
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
        let projections = binding::current_source_rows(graph, request.source_root, &source_ids)?;
        let episodes = binding::source_episodes(rows.values());
        let hydrated = hydrate_recall_sources(RecallSourceHydration {
            data_root: request.source_root,
            memory_root: request.memory_root,
            reader: request.canonical,
            rows: &projections,
            episodes: &episodes,
            max_graphemes: 480,
            deadline_at: request.deadline_at,
            now_millis: clocks.now_millis,
            compare_locale: clocks.compare_locale,
        });
        Ok(Self {
            rows,
            raw,
            mentions,
            projections,
            hydrated,
        })
    }

    fn episode_mentions(&self, episode_id: &str) -> Vec<RecallMention> {
        self.mentions
            .iter()
            .filter(|mention| mention.episode_id == episode_id)
            .cloned()
            .collect()
    }
}

/// Rebinds every candidate whose episode revision is unchanged and that is
/// not newly superseded; anything missing marks the page source-partial.
fn bind_page(
    request: &ContinuationInput<'_>,
    slice: &[Candidate],
    sources: &PageSources,
    clocks: Clocks<'_>,
) -> CognitionResult<Bound> {
    let source_by_id = sources
        .projections
        .iter()
        .map(|row| (row.source_id.as_str(), row))
        .collect::<HashMap<_, _>>();
    let mut bound = Bound {
        full: Vec::new(),
        offsets: Vec::new(),
        source_partial: false,
    };
    for (index, metadata) in slice.iter().enumerate() {
        let Some(row) = sources
            .rows
            .get(&metadata.episode_ref)
            .filter(|row| row.revision == metadata.revision)
        else {
            bound.source_partial = true;
            continue;
        };
        let relationship =
            request
                .graph
                .relationship_state(request.input, &row.episode_id, request.now_iso)?;
        if relationship.superseded && !sources.raw.contains(&row.episode_id) {
            bound.source_partial = true;
            continue;
        }
        let episode_mentions = sources.episode_mentions(&row.episode_id);
        if episode_mentions.iter().any(|mention| {
            !matches!(
                sources.hydrated.get(&mention.source_id),
                Some(RecallSourceResolution::Value(_))
            )
        }) {
            bound.source_partial = true;
        }
        let bind = BindInput {
            graph: request.graph,
            input: request.input,
            generation_id: request.generation_id,
            row,
            metadata,
            mentions: &episode_mentions,
            relationship: &relationship,
            sources: &source_by_id,
            hydrated: &sources.hydrated,
            now_iso: request.now_iso,
        };
        if let Some(item) = result::bind(&bind, clocks.parse_date)? {
            bound.full.push(item);
            bound.offsets.push(index);
        } else {
            bound.source_partial = true;
        }
    }
    Ok(bound)
}

/// Minimum bundles in page order until the envelope is full.
fn fit_minimum(
    request: &ContinuationInput<'_>,
    frame: &PageFrame<'_>,
    sources: &PageSources,
    bound: &Bound,
    clocks: Clocks<'_>,
) -> CognitionResult<Fitted> {
    let mut fitted = Fitted {
        results: Vec::new(),
        included: Vec::new(),
        budget_trimmed: false,
    };
    for (item, offset) in bound.full.iter().zip(&bound.offsets) {
        let minimum = envelope::minimum(
            item,
            |evidence| {
                let Some(row) = sources.rows.get(&item.episode_ref) else {
                    return Err(CognitionError::new(
                        CognitionCode::MemoryRecallUnavailable,
                        "memory_recall_unavailable",
                    ));
                };
                let episode_mentions = sources.episode_mentions(&row.episode_id);
                result::rebind(
                    request.graph,
                    request.input,
                    row,
                    &episode_mentions,
                    item,
                    evidence,
                    clocks.parse_date,
                )
            },
            clocks.compare_locale,
        )?;
        fitted.results.push(minimum);
        fitted.included.push(*offset);
        let delivery = Delivery {
            included: &fitted.included,
            source_partial: bound.source_partial,
            budget_trimmed: fitted.budget_trimmed,
        };
        if envelope::bytes(&result::view(frame, &fitted.results, &delivery))? > envelope::MAX_BYTES
        {
            fitted.results.pop();
            fitted.included.pop();
            fitted.budget_trimmed = true;
            if !fitted.results.is_empty() {
                break;
            }
        }
    }
    Ok(fitted)
}

/// Replaces each minimum bundle with its full bundle where the envelope
/// still fits.
fn upgrade_to_full(
    frame: &PageFrame<'_>,
    mut results: Vec<RecallResultItem>,
    delivery: &Delivery<'_>,
    bound: &Bound,
) -> CognitionResult<Vec<RecallResultItem>> {
    for (index, offset) in delivery.included.iter().enumerate() {
        let Some(full) = bound
            .offsets
            .iter()
            .position(|value| value == offset)
            .and_then(|position| bound.full.get(position))
        else {
            continue;
        };
        let Some(slot) = results.get_mut(index) else {
            continue;
        };
        let minimum = std::mem::replace(slot, full.clone());
        if envelope::bytes(&result::view(frame, &results, delivery))? > envelope::MAX_BYTES
            && let Some(slot) = results.get_mut(index)
        {
            *slot = minimum;
        }
    }
    Ok(results)
}

pub(super) fn stale() -> CognitionError {
    CognitionError::new(CognitionCode::StaleCursor, "stale_cursor")
}
