//! Snapshot inventory from canonical Conversation and the source typed registry.

use crate::cognition::CognitionCode;
use butler_platform::sqlite;
use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use indexmap::IndexMap;
use rusqlite::OpenFlags;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::cognition::recall::{
    RecallAdmittedChannels, RecallProjectFilter, RecallRuntime, RecallScope,
};
use crate::cognition::sources::{read_canonical_inventory, read_explicit_record, read_task_report};
use crate::cognition::{
    CognitionError, CognitionResult, RecallRequest, ensure_data_authority,
    split_historical_source_spans,
};
use crate::work_records::{ReadAvailability, WorkRecordReader, task_memory_record_id};
use butler_core::locale::LocaleCollation;
use butler_turn::conversation::ConversationSourceReader;
mod typed;
use typed::typed_registry;

const INVENTORY_SCHEMA: &str = "butler.memory-source-inventory.v1";
const ORIGIN_VERSION: &str = "conversation-origin-v1";

/// One canonical conversation episode and the source units it contributes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::cognition) struct ConversationEntry {
    pub episode_id: String,
    pub revision: String,
    pub source_unit_count: usize,
    pub source_ids: Vec<String>,
    pub source_hashes: Vec<String>,
    pub origin_kinds: Vec<String>,
}

/// One typed memory record (task report or explicit rule) and its source spans.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(in crate::cognition) struct TypedEntry {
    pub source_kind: String,
    pub record_kind: String,
    pub record_id: String,
    pub revision: String,
    pub operation_id: String,
    pub content_hash: String,
    pub project_id: Option<String>,
    pub conversation_session_id: Option<String>,
    pub conversation_message_id: Option<String>,
    pub observed_at: String,
    pub role: String,
    pub basis: String,
    pub lifecycle: String,
    pub source_ids: Vec<String>,
}

/// Historical origin classification counters; always zero for native prepare.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(in crate::cognition) struct Origin {
    pub version: String,
    pub applied: u8,
    pub unchanged: u8,
    pub unknown: u8,
}

/// The lifecycle binding of a typed source, hashed so that a changed binding
/// changes the inventory.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "source_kind", rename_all = "snake_case")]
pub(in crate::cognition) enum TypedLifecycle {
    /// A task memory report.
    TaskReport {
        task_id: String,
        /// Passthrough: the task's `memory-report-binding.json` plus `text`.
        report: Value,
    },
    /// An explicit rule.
    ExplicitRecord {
        record_id: String,
        /// Passthrough: the rule's `.source.json` binding.
        binding: Value,
    },
    /// All feedback quality operations.
    FeedbackQualityOperations {
        /// Passthrough: each operation record as stored.
        operations: Vec<Value>,
    },
}

/// A snapshot's `memory-source-inventory.json`: every source the candidate
/// must register.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(in crate::cognition) struct MemorySourceInventory {
    pub schema: String,
    pub as_of: String,
    pub origin: Origin,
    pub exclusions: IndexMap<String, usize>,
    pub entries: Vec<ConversationEntry>,
    pub typed: Vec<TypedEntry>,
    pub typed_lifecycle: Vec<TypedLifecycle>,
}

impl MemorySourceInventory {
    /// Reads a stored inventory; any failure means the snapshot changed.
    pub(in crate::cognition) fn read(path: &Path) -> CognitionResult<Self> {
        let bytes = fs::read(path)
            .map_err(|source| error(CognitionCode::MemorySnapshotChanged).with_source(source))?;
        let inventory: Self = serde_json::from_slice(&bytes)
            .map_err(|source| error(CognitionCode::MemorySnapshotChanged).with_source(source))?;
        if inventory.schema != INVENTORY_SCHEMA {
            return Err(error(CognitionCode::MemorySnapshotChanged));
        }
        Ok(inventory)
    }

    /// The inventory hash: every field but `as_of`, plus an empty history.
    fn hash(&self) -> CognitionResult<String> {
        #[derive(Serialize)]
        struct HashedInventory<'a> {
            schema: &'a str,
            origin_version: &'a str,
            exclusions: &'a IndexMap<String, usize>,
            entries: &'a [ConversationEntry],
            typed: &'a [TypedEntry],
            typed_lifecycle: &'a [TypedLifecycle],
            history: [(); 0],
        }
        let material = HashedInventory {
            schema: &self.schema,
            origin_version: &self.origin.version,
            exclusions: &self.exclusions,
            entries: &self.entries,
            typed: &self.typed,
            typed_lifecycle: &self.typed_lifecycle,
            history: [],
        };
        Ok(digest(&serde_json::to_vec(&material).map_err(
            |source| error(CognitionCode::MemoryInventoryIncomplete).with_source(source),
        )?))
    }

    /// Source units the inventory expects to be registered.
    fn source_count(&self) -> usize {
        self.entries
            .iter()
            .map(|entry| entry.source_unit_count)
            .sum::<usize>()
            + self
                .typed
                .iter()
                .map(|entry| entry.source_ids.len())
                .sum::<usize>()
    }
}

/// A freshly read inventory with its hash and the canonical revision it saw.
pub(super) struct SourceInventory {
    pub inventory: MemorySourceInventory,
    pub hash: String,
    pub source_count: usize,
    pub canonical_revision: i64,
}

/// Reads the inventory of the sources under `data_root` as of `as_of`.
pub(super) fn read(
    data_root: &Path,
    canonical_path: &Path,
    as_of: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<SourceInventory> {
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    ensure_data_authority(
        data_root,
        &[
            canonical_path,
            &data_root.join("tasks"),
            &data_root.join("cognition/memory/rules"),
            &data_root.join("cognition/feedback"),
            &data_root.join("butler.config.json"),
        ],
    )?;
    let collation = LocaleCollation::new("en-US")
        .map_err(|source| error(CognitionCode::MemoryInventoryIncomplete).with_source(source))?;
    let (exclusions, entries) =
        conversation_entries(canonical_path, as_of, &collation, cancellation)?;
    let (typed, typed_lifecycle) = typed_registry(data_root, cancellation, &collation)?;
    let inventory = MemorySourceInventory {
        schema: INVENTORY_SCHEMA.into(),
        as_of: as_of.to_owned(),
        origin: Origin {
            version: ORIGIN_VERSION.into(),
            applied: 0,
            unchanged: 0,
            unknown: 0,
        },
        exclusions,
        entries,
        typed,
        typed_lifecycle,
    };
    Ok(SourceInventory {
        hash: inventory.hash()?,
        source_count: inventory.source_count(),
        canonical_revision: canonical_revision(canonical_path)?,
        inventory,
    })
}

/// Every canonical conversation episode visible to recall as of `as_of`, and
/// the counts of excluded ones by reason.
fn conversation_entries(
    canonical_path: &Path,
    as_of: &str,
    collation: &LocaleCollation,
    cancellation: &CancellationToken,
) -> CognitionResult<(IndexMap<String, usize>, Vec<ConversationEntry>)> {
    let reader = ConversationSourceReader::open(canonical_path)
        .map_err(|source| error(CognitionCode::MemoryInventoryIncomplete).with_source(source))?;
    let scanned = read_canonical_inventory(
        Some(&reader),
        &inventory_request(as_of),
        millis().saturating_add(60_000),
        &|date| {
            butler_core::js_date::parse_date_millis(date, &|value| Some(value))
                .map(|value| value as f64)
                .unwrap_or(f64::NAN)
        },
        &|left, right| collation.compare(left, right),
        millis,
    )?;
    reader
        .close()
        .map_err(|source| error(CognitionCode::MemoryInventoryIncomplete).with_source(source))?;
    if !scanned.available || scanned.partial || cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryInventoryIncomplete));
    }
    // JS prepare classifies historical unknown origins first. This native
    // packet preserves the original canonical bytes, so unclassified origins
    // require an explicit source repair rather than silently excluding them.
    if scanned
        .exclusions
        .get("unknown_origin")
        .is_some_and(|count| *count > 0)
    {
        return Err(error(CognitionCode::MemorySourceOriginUnclassified));
    }
    let mut exclusions = scanned.exclusions;
    exclusions.retain(|_, count| *count > 0);
    let entries = scanned
        .entries
        .into_iter()
        .map(|entry| ConversationEntry {
            episode_id: entry.episode_id,
            revision: entry.revision,
            source_unit_count: entry.source_unit_count,
            source_ids: entry.source_ids,
            source_hashes: entry.source_hashes,
            origin_kinds: entry.origin_kinds,
        })
        .collect();
    Ok((exclusions, entries))
}

/// An empty recall request over every user session, used only to enumerate.
fn inventory_request(as_of: &str) -> RecallRequest {
    RecallRequest {
        cue: String::new(),
        seed_phrases: Vec::new(),
        vector_queries: Vec::new(),
        include_vector: false,
        include_internal: false,
        limit: 0,
        scope: RecallScope::AllUserSessions,
        project_filter: RecallProjectFilter::Any,
        project_ids: Vec::new(),
        session_ids: Vec::new(),
        as_of: as_of.to_owned(),
        as_of_explicit: true,
        time: None,
        cursor: None,
        admitted_channels: Some(RecallAdmittedChannels::default()),
        runtime: RecallRuntime {
            session_id: String::new(),
            turn_id: String::new(),
            current_user_message: String::new(),
            native_operation_id: String::new(),
            project_id: None,
        },
    }
}

fn canonical_revision(canonical_path: &Path) -> CognitionResult<i64> {
    let connection = sqlite::open_with_flags(canonical_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|source| error(CognitionCode::MemoryInventoryIncomplete).with_source(source))?;
    connection
        .query_row(
            "SELECT revision FROM conversation_public_source_state WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(|source| error(CognitionCode::MemoryInventoryIncomplete).with_source(source))
}

fn entry(record: crate::cognition::sources::TypedMemoryRecord) -> CognitionResult<TypedEntry> {
    let episode = crate::cognition::sources::projection_hash_for_graph(&(
        "typed-memory-record",
        &record.source_kind,
        &record.record_id,
    ))
    .map_err(|source| error(CognitionCode::MemoryInventoryIncomplete).with_source(source))?;
    let mut source_ids = Vec::new();
    for span in split_historical_source_spans(&record.text, 32_768.0) {
        source_ids.push(
            crate::cognition::sources::projection_hash_for_graph(&(
                "memory-source",
                &episode,
                &record.revision,
                &record.source_kind,
                &record.record_id,
                &span.start,
                &span.end,
                &record.content_hash,
            ))
            .map_err(|source| {
                error(CognitionCode::MemoryInventoryIncomplete).with_source(source)
            })?,
        );
    }
    Ok(TypedEntry {
        source_kind: record.source_kind.into(),
        record_kind: record.record_kind.into(),
        record_id: record.record_id,
        revision: record.revision,
        operation_id: record.operation_id,
        content_hash: record.content_hash,
        project_id: record.project_id,
        conversation_session_id: record.conversation_session_id,
        conversation_message_id: record.conversation_message_id,
        observed_at: record.observed_at,
        role: record.role.into(),
        basis: record.basis.into(),
        lifecycle: "current".into(),
        source_ids,
    })
}

fn millis() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(i64::MAX)
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
