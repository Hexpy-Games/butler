//! Full interpretation bundles and packed variants, scoped to a caller and source pin.
//! A bounded five-minute inventory never serves a bundle under a different pin.
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
};

use crate::cognition::{
    CognitionCode, CognitionError, CognitionPathEnvironment, CognitionResult,
    MemoryGenerationHandle,
    graph::GraphRecallReader,
    recall::{RecallResponse, RecallResultItem},
    resolve_active_generation,
};
use butler_turn::conversation::{
    CanonicalMemoryReadBinding, ConversationSourceReader, PublicMemorySnapshot,
    conversation_store_path,
};

const TTL: i64 = 300_000;
const MAX_ENTRIES: usize = 640; // 32 pages at the public maximum of 20 results.

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct DetailPin {
    generation: String,
    graph_revision: String,
    canonical: Option<(Option<String>, u64)>,
}

impl DetailPin {
    pub(super) fn new(
        generation: &MemoryGenerationHandle,
        graph: &GraphRecallReader,
        canonical: Option<&ConversationSourceReader>,
    ) -> CognitionResult<Self> {
        let canonical = canonical
            .map(|reader| Ok((reader.source_identity()?, reader.public_revision()?)))
            .transpose()
            .map_err(|error: butler_turn::conversation::ConversationError| {
                CognitionError::new(CognitionCode::CanonicalSourceUnavailable, error.to_string())
            })?;
        Ok(Self {
            generation: generation.generation_id.clone(),
            graph_revision: graph.revision().into(),
            canonical,
        })
    }
}

struct Entry {
    handle: String,
    caller: (String, Option<String>),
    pin: DetailPin,
    created: i64,
    episode_ref: Value,
    bundle: Bundle,
}

#[derive(Serialize)]
struct Bundle {
    interpretations: Value,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    first_page_interpretations: Vec<Value>,
    evidence: Value,
}

impl Bundle {
    fn new(full: &RecallResultItem, selected: Value) -> CognitionResult<Self> {
        let interpretations = encode(&full.interpretations)?;
        let Value::Array(selected) = selected else {
            return Err(stale());
        };
        let records = interpretations.as_array().ok_or_else(stale)?;
        let first_page_interpretations = selected
            .into_iter()
            .filter(|record| !records.contains(record))
            .collect();
        Ok(Self {
            interpretations,
            first_page_interpretations,
            evidence: encode(&full.evidence)?,
        })
    }

    fn count(&self) -> usize {
        self.interpretations.as_array().map_or(0, Vec::len) + self.first_page_interpretations.len()
    }
}

/// Keep the complete hydrated view even when the envelope selected a minimum bundle.
pub(super) fn retain_full<'a>(
    response: &mut RecallResponse,
    full: impl IntoIterator<Item = &'a RecallResultItem>,
) -> CognitionResult<()> {
    let full = full
        .into_iter()
        .map(|item| ((&item.episode_ref, &item.revision), item))
        .collect::<HashMap<_, _>>();
    response.full_details = response
        .results
        .iter()
        .map(|item| {
            full.get(&(&item.episode_ref, &item.revision))
                .map(|full| (**full).clone())
                .ok_or_else(stale)
        })
        .collect::<CognitionResult<_>>()?;
    Ok(())
}

fn encode(value: &impl Serialize) -> CognitionResult<Value> {
    serde_json::to_value(value)
        .map_err(|error| CognitionError::new(CognitionCode::SerializationBudget, error.to_string()))
}

#[derive(Default)]
pub(super) struct DetailStore(Mutex<VecDeque<Entry>>);

impl DetailStore {
    /// Project only after the unchanged complete-bundle envelope has selected a page.
    pub(super) fn compact(
        &self,
        value: &mut Value,
        pin: Option<&DetailPin>,
        full: &[RecallResultItem],
        binding: &CanonicalMemoryReadBinding,
        now: i64,
    ) -> CognitionResult<()> {
        let mut entries = self.0.lock();
        entries.retain(|entry| now - entry.created <= TTL);
        for row in value["results"].as_array_mut().into_iter().flatten() {
            let pin = pin.ok_or_else(stale)?;
            let interpretations = row
                .as_object_mut()
                .and_then(|row| row.remove("interpretations"))
                .ok_or_else(stale)?;
            let full = full
                .iter()
                .find(|item| {
                    row["episode_ref"] == item.episode_ref && row["revision"] == item.revision
                })
                .ok_or_else(stale)?;
            let bundle = Bundle::new(full, interpretations)?;
            let caller = (
                binding.runtime_session_id.clone(),
                binding.project_id.clone(),
            );
            let key = serde_json::to_vec(&json!([
                pin,
                caller,
                row["episode_ref"],
                row["revision"],
                bundle
            ]))
            .map_err(|error| {
                CognitionError::new(CognitionCode::InvalidArguments, error.to_string())
            })?;
            let handle = format!("memory-detail:v1:{:x}", Sha256::digest(key));
            row["interpretation_handle"] = json!(handle);
            row["interpretation_count"] = json!(bundle.count());
            // Recalling the same bundle renews its lifetime without changing its handle.
            entries.retain(|entry| entry.handle != handle);
            entries.push_back(Entry {
                handle,
                caller,
                pin: pin.clone(),
                created: now,
                episode_ref: row["episode_ref"].clone(),
                bundle,
            });
        }
        while entries.len() > MAX_ENTRIES {
            entries.pop_front();
        }
        Ok(())
    }

    fn read(
        &self,
        handles: &[String],
        binding: &CanonicalMemoryReadBinding,
        pin: &DetailPin,
        now: i64,
    ) -> CognitionResult<Value> {
        let entries = self.0.lock();
        let caller = (
            binding.runtime_session_id.clone(),
            binding.project_id.clone(),
        );
        let details = handles
            .iter()
            .map(|handle| {
                let entry = entries
                    .iter()
                    .find(|entry| {
                        &entry.handle == handle
                            && entry.caller == caller
                            && &entry.pin == pin
                            && now - entry.created <= TTL
                    })
                    .ok_or_else(stale)?;
                Ok(
                    json!({"interpretation_handle":handle, "episode_ref":entry.episode_ref,
                "interpretations":entry.bundle.interpretations,
                "first_page_interpretations":entry.bundle.first_page_interpretations,
                "evidence":entry.bundle.evidence}),
                )
            })
            .collect::<CognitionResult<Vec<_>>>()?;
        Ok(json!({"ok":true, "details":details}))
    }
}

pub(super) fn expand(
    root: &Path,
    environment: &CognitionPathEnvironment,
    store: &DetailStore,
    binding: &CanonicalMemoryReadBinding,
    arguments: &Value,
    now: i64,
) -> CognitionResult<Value> {
    let handles: Vec<String> = serde_json::from_value(arguments["detail_handles"].clone())
        .map_err(|error| CognitionError::new(CognitionCode::InvalidArguments, error.to_string()))?;
    if handles.is_empty() || handles.len() > 20 || arguments.get("cursor").is_some() {
        return Err(CognitionError::new(
            CognitionCode::InvalidArguments,
            "invalid detail_handles",
        ));
    }
    // Revalidate the current caller; handles never grant access to another caller.
    let _caller = PublicMemorySnapshot::open(&conversation_store_path(root), binding)
        .map_err(|error| CognitionError::new(CognitionCode::InvalidScope, error.code()))?;
    let generation = resolve_active_generation(root, environment)?;
    let (canonical, graph) = super::query::open_sources(&generation)?;
    let result = DetailPin::new(&generation, &graph, canonical.as_ref())
        .and_then(|pin| store.read(&handles, binding, &pin, now));
    super::query::close_sources(graph, canonical, result)
}

fn stale() -> CognitionError {
    CognitionError::new(
        CognitionCode::StaleDetailHandle,
        "stale_detail_handle: generation/revision changed or handle expired; call recall_memory again",
    )
}
