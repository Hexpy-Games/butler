//! Snapshot inventory from canonical Conversation and the source typed registry.

use crate::cognition::CognitionCode;
use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use indexmap::IndexMap;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
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
    let connection = Connection::open_with_flags(canonical_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|source| error(CognitionCode::MemoryInventoryIncomplete).with_source(source))?;
    connection
        .query_row(
            "SELECT revision FROM conversation_public_source_state WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(|source| error(CognitionCode::MemoryInventoryIncomplete).with_source(source))
}

/// Typed records and their lifecycle bindings, in collation order.
fn typed_registry(
    data_root: &Path,
    cancellation: &CancellationToken,
    collation: &LocaleCollation,
) -> CognitionResult<(Vec<TypedEntry>, Vec<TypedLifecycle>)> {
    let mut typed = Vec::new();
    let mut lifecycle = Vec::new();
    task_reports(data_root, cancellation, &mut typed, &mut lifecycle)?;
    explicit_rules(data_root, cancellation, &mut typed, &mut lifecycle)?;
    lifecycle.push(TypedLifecycle::FeedbackQualityOperations {
        operations: quality_operations(data_root, collation)?,
    });
    typed.sort_by(|a, b| {
        collation.compare(
            &format!("{}\0{}", a.source_kind, a.record_id),
            &format!("{}\0{}", b.source_kind, b.record_id),
        )
    });
    let mut keyed = lifecycle
        .into_iter()
        .map(|entry| {
            serde_json::to_string(&entry)
                .map(|key| (key, entry))
                .map_err(|source| {
                    error(CognitionCode::MemoryInventoryIncomplete).with_source(source)
                })
        })
        .collect::<CognitionResult<Vec<_>>>()?;
    keyed.sort_by(|a, b| collation.compare(&a.0, &b.0));
    Ok((typed, keyed.into_iter().map(|(_, entry)| entry).collect()))
}

/// Each task's memory report and its binding with the report text.
fn task_reports(
    data_root: &Path,
    cancellation: &CancellationToken,
    typed: &mut Vec<TypedEntry>,
    lifecycle: &mut Vec<TypedLifecycle>,
) -> CognitionResult<()> {
    let unavailable = |source| error(CognitionCode::MemorySourceUnavailable).with_source(source);
    let tasks = WorkRecordReader::new(data_root);
    let mut task_ids = tasks.task_ids().map_err(unavailable)?;
    task_ids.sort();
    for task_id in task_ids {
        if cancellation.is_cancelled() {
            return Err(error(CognitionCode::MemoryOperationAborted));
        }
        let Some(report) = tasks
            .read_memory_report(&task_id, ReadAvailability::Strict)
            .map_err(unavailable)?
        else {
            continue;
        };
        let record = read_task_report(data_root, &task_memory_record_id(&task_id))?
            .ok_or_else(|| error(CognitionCode::MemorySourceUnavailable))?;
        typed.push(entry(record)?);
        let binding_path = data_root
            .join("tasks")
            .join(&task_id)
            .join("memory-report-binding.json");
        let mut binding: serde_json::Map<String, Value> =
            serde_json::from_slice(&fs::read(binding_path).map_err(|source| {
                error(CognitionCode::MemorySourceUnavailable).with_source(source)
            })?)
            .map_err(|source| error(CognitionCode::MemorySourceUnavailable).with_source(source))?;
        binding.insert("text".into(), Value::String(report.text));
        lifecycle.push(TypedLifecycle::TaskReport {
            task_id,
            report: Value::Object(binding),
        });
    }
    Ok(())
}

/// Explicit rules bound by a `<record>.source.json` file.
fn explicit_rules(
    data_root: &Path,
    cancellation: &CancellationToken,
    typed: &mut Vec<TypedEntry>,
    lifecycle: &mut Vec<TypedLifecycle>,
) -> CognitionResult<()> {
    #[derive(Deserialize)]
    struct RuleBinding {
        #[serde(default, deserialize_with = "crate::lenient::option")]
        schema: Option<String>,
        #[serde(default, deserialize_with = "crate::lenient::option")]
        record_id: Option<String>,
    }
    let unavailable = |source| error(CognitionCode::MemorySourceUnavailable).with_source(source);
    let rules = data_root.join("cognition/memory/rules");
    if !rules.is_dir() {
        return Ok(());
    }
    let mut names = fs::read_dir(&rules)
        .map_err(unavailable)?
        .map(|item| item.map(|value| value.file_name().to_string_lossy().into_owned()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(unavailable)?;
    names.sort();
    for name in names
        .into_iter()
        .filter(|name| name.ends_with(".source.json"))
    {
        if cancellation.is_cancelled() {
            return Err(error(CognitionCode::MemoryOperationAborted));
        }
        let record_id = name.trim_end_matches(".source.json");
        let bytes = fs::read(rules.join(&name)).map_err(unavailable)?;
        let binding: Value = serde_json::from_slice(&bytes)
            .map_err(|source| error(CognitionCode::MemorySourceUnavailable).with_source(source))?;
        let header = RuleBinding::deserialize(&binding).unwrap_or(RuleBinding {
            schema: None,
            record_id: None,
        });
        if header.schema.as_deref() != Some("butler.explicit-rule-binding.v1")
            || header.record_id.as_deref() != Some(record_id)
        {
            continue;
        }
        if let Some(record) = read_explicit_record(&data_root.join("cognition/memory"), record_id)?
        {
            typed.push(entry(record)?);
        }
        lifecycle.push(TypedLifecycle::ExplicitRecord {
            record_id: record_id.to_owned(),
            binding,
        });
    }
    Ok(())
}

/// Feedback quality operations in `operation_id` collation order.
fn quality_operations(
    data_root: &Path,
    collation: &LocaleCollation,
) -> CognitionResult<Vec<Value>> {
    #[derive(Deserialize)]
    struct OperationHeader {
        #[serde(default, deserialize_with = "crate::lenient::option")]
        schema: Option<String>,
        #[serde(default, deserialize_with = "crate::lenient::option")]
        operation_id: Option<String>,
    }
    let quality = data_root.join("cognition/feedback/quality-operations.jsonl");
    if !quality.is_file() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(quality)
        .map_err(|source| error(CognitionCode::MemorySourceUnavailable).with_source(source))?;
    let mut operations = content
        .trim()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|value| {
            let header = OperationHeader::deserialize(&value).ok()?;
            (header.schema.as_deref() == Some("butler.memory-source-quality-operation.v1"))
                .then(|| (header.operation_id.unwrap_or_default(), value))
        })
        .collect::<Vec<_>>();
    operations.sort_by(|a, b| collation.compare(&a.0, &b.0));
    Ok(operations.into_iter().map(|(_, value)| value).collect())
}

fn entry(record: crate::cognition::sources::TypedMemoryRecord) -> CognitionResult<TypedEntry> {
    let episode = crate::cognition::sources::projection_hash_for_graph(vec![
        json!("typed-memory-record"),
        json!(record.source_kind),
        json!(record.record_id),
    ])
    .map_err(|source| error(CognitionCode::MemoryInventoryIncomplete).with_source(source))?;
    let mut source_ids = Vec::new();
    for span in split_historical_source_spans(&record.text, 32_768.0) {
        source_ids.push(
            crate::cognition::sources::projection_hash_for_graph(vec![
                json!("memory-source"),
                json!(episode),
                json!(record.revision),
                json!(record.source_kind),
                json!(record.record_id),
                json!(span.start),
                json!(span.end),
                json!(record.content_hash),
            ])
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
