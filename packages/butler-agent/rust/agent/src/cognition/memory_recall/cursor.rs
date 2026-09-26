//! Bounded, query-local-metadata-only continuation inventory.

use parking_lot::Mutex;
use std::collections::HashMap;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::cognition::recall::{
    RecallAssociationStep, RecallCoverage, RecallRequest, RecallStatus,
};
use crate::cognition::{CognitionError, CognitionResult};

const TTL_MILLIS: i64 = 300_000;
const MAX_ENTRIES: usize = 32;
const MAX_CANDIDATES: usize = 128;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug)]
pub(super) struct Candidate {
    pub episode_ref: String,
    pub revision: String,
    pub channels: Vec<String>,
    pub matched_node_ref: Option<String>,
    pub association_path: Vec<RecallAssociationStep>,
    pub qualifications: Vec<String>,
}

#[derive(Clone, Debug)]
pub(super) struct Inventory {
    pub created_at: i64,
    pub argument_hash: String,
    pub generation_id: String,
    pub graph_revision: String,
    pub as_of: String,
    pub candidates: Vec<Candidate>,
    pub status: Option<RecallStatus>,
    pub coverage: Option<RecallCoverage>,
    pub diagnostics: Option<Vec<String>>,
}

#[derive(Clone, Debug)]
pub(super) struct Page {
    pub key: String,
    pub offset: usize,
    pub inventory: Inventory,
}

#[derive(Default)]
struct State {
    entries: HashMap<String, Inventory>,
    order: Vec<String>,
}

#[derive(Default)]
pub(super) struct CursorStore(Mutex<State>);

#[derive(Serialize)]
struct WireCursor {
    schema: String,
    key: String,
    offset: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArgumentHash<'a> {
    cue: &'a str,
    seed_phrases: &'a [String],
    vector_queries: &'a [String],
    include_vector: bool,
    include_internal: bool,
    admitted_channels: Option<&'a crate::cognition::recall::RecallAdmittedChannels>,
    limit: usize,
    scope: crate::cognition::recall::RecallScope,
    project_filter: crate::cognition::recall::RecallProjectFilter,
    project_ids: &'a [String],
    session_ids: &'a [String],
    time: Option<&'a crate::cognition::recall::RecallTime>,
    as_of: &'a str,
    runtime: ArgumentRuntime<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArgumentRuntime<'a> {
    session_id: &'a str,
    project_id: Option<&'a str>,
}

pub(super) fn argument_hash(input: &RecallRequest, as_of: &str) -> CognitionResult<String> {
    let value = ArgumentHash {
        cue: &input.cue,
        seed_phrases: &input.seed_phrases,
        vector_queries: &input.vector_queries,
        include_vector: input.include_vector,
        include_internal: input.include_internal,
        admitted_channels: input.admitted_channels.as_ref(),
        limit: input.limit,
        scope: input.scope,
        project_filter: input.project_filter,
        project_ids: &input.project_ids,
        session_ids: &input.session_ids,
        time: input.time.as_ref(),
        as_of,
        runtime: ArgumentRuntime {
            session_id: &input.runtime.session_id,
            project_id: input.runtime.project_id.as_deref(),
        },
    };
    let bytes = serde_json::to_vec(&value)
        .map_err(|_| CognitionError::new("invalid_arguments", "invalid_arguments"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub(super) fn encode(key: &str, offset: usize) -> String {
    let wire = serde_json::json!({
        "schema": "butler.recall-cursor.v2",
        "key": key,
        "offset": offset,
    });
    URL_SAFE_NO_PAD.encode(wire.to_string())
}

fn decode(cursor: &str) -> CognitionResult<WireCursor> {
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| invalid_arguments())?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| invalid_arguments())?;
    let schema = value.get("schema").and_then(serde_json::Value::as_str);
    let key = value.get("key").and_then(serde_json::Value::as_str);
    let offset = value.get("offset").and_then(serde_json::Value::as_f64);
    let Some(offset) = offset.filter(|number| {
        number.is_finite()
            && *number >= 0.0
            && number.fract() == 0.0
            && *number <= MAX_SAFE_INTEGER as f64
    }) else {
        return Err(invalid_arguments());
    };
    let (Some(schema @ "butler.recall-cursor.v2"), Some(key)) = (schema, key) else {
        return Err(invalid_arguments());
    };
    Ok(WireCursor {
        schema: schema.into(),
        key: key.into(),
        offset: crate::json::saturating_u64(offset),
    })
}

fn invalid_arguments() -> CognitionError {
    CognitionError::new("invalid_arguments", "invalid_arguments")
}

impl CursorStore {
    pub(super) fn read(&self, cursor: &str, now: i64) -> CognitionResult<Page> {
        let wire = decode(cursor)?;
        let mut state = self.0.lock();
        state.expire(now);
        let inventory = state
            .entries
            .get(&wire.key)
            .cloned()
            .ok_or_else(|| CognitionError::new("cursor_expired", "cursor_expired"))?;
        state.touch(&wire.key);
        Ok(Page {
            key: wire.key,
            offset: usize::try_from(wire.offset).unwrap_or(usize::MAX),
            inventory,
        })
    }

    pub(super) fn insert(
        &self,
        input: &RecallRequest,
        generation_id: &str,
        graph_revision: &str,
        candidates: Vec<Candidate>,
        now: i64,
    ) -> CognitionResult<Page> {
        let argument_hash = argument_hash(input, &input.as_of)?;
        let nonce = uuid::Uuid::new_v4();
        let key = format!(
            "{:x}",
            Sha256::digest(format!(
                "{argument_hash}:{generation_id}:{graph_revision}:{now}:{nonce}"
            ))
        );
        let inventory = Inventory {
            created_at: now,
            argument_hash,
            generation_id: generation_id.into(),
            graph_revision: graph_revision.into(),
            as_of: input.as_of.clone(),
            candidates: candidates.into_iter().take(MAX_CANDIDATES).collect(),
            status: None,
            coverage: None,
            diagnostics: None,
        };
        let mut state = self.0.lock();
        state.expire(now);
        state.entries.insert(key.clone(), inventory.clone());
        state.touch(&key);
        while state.order.len() > MAX_ENTRIES {
            let oldest = state.order.remove(0);
            state.entries.remove(&oldest);
        }
        Ok(Page {
            key,
            offset: 0,
            inventory,
        })
    }

    pub(super) fn update(
        &self,
        key: &str,
        response: &crate::cognition::recall::RecallResponse,
    ) -> CognitionResult<()> {
        let mut state = self.0.lock();
        if let Some(entry) = state.entries.get_mut(key) {
            entry.status = Some(response.status);
            entry.coverage = Some(response.coverage.clone());
            entry.diagnostics = Some(response.diagnostics.clone());
        }
        if response.next_cursor.is_none() {
            state.remove(key);
        }
        Ok(())
    }

    pub(super) fn remove(&self, key: &str) -> CognitionResult<()> {
        self.0.lock().remove(key);
        Ok(())
    }
}

impl State {
    fn expire(&mut self, now: i64) {
        self.order.retain(|key| {
            self.entries
                .get(key)
                .is_some_and(|entry| now - entry.created_at <= TTL_MILLIS)
        });
        self.entries.retain(|key, _| self.order.contains(key));
    }

    fn touch(&mut self, key: &str) {
        self.order.retain(|value| value != key);
        self.order.push(key.into());
    }

    fn remove(&mut self, key: &str) {
        self.entries.remove(key);
        self.order.retain(|value| value != key);
    }
}
