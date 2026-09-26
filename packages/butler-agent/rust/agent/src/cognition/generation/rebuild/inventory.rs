//! Snapshot inventory from canonical Conversation and the source typed registry.

use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use indexmap::IndexMap;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::{
    cognition::{
        CognitionError, CognitionResult, RecallRequest, ensure_data_authority,
        recall::{RecallAdmittedChannels, RecallProjectFilter, RecallRuntime, RecallScope},
        sources::{read_canonical_inventory, read_explicit_record, read_task_report},
        split_historical_source_spans,
    },
    conversation::ConversationSourceReader,
    locale::LocaleCollation,
    work_records::{ReadAvailability, WorkRecordReader, task_memory_record_id},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationEntry {
    episode_id: String,
    revision: String,
    source_unit_count: usize,
    source_ids: Vec<String>,
    source_hashes: Vec<String>,
    origin_kinds: Vec<String>,
}

#[derive(Serialize)]
struct TypedEntry {
    source_kind: &'static str,
    record_kind: &'static str,
    record_id: String,
    revision: String,
    operation_id: String,
    content_hash: String,
    project_id: Option<String>,
    conversation_session_id: Option<String>,
    conversation_message_id: Option<String>,
    observed_at: String,
    role: &'static str,
    basis: &'static str,
    lifecycle: &'static str,
    source_ids: Vec<String>,
}

#[derive(Serialize)]
struct Origin {
    version: &'static str,
    applied: u8,
    unchanged: u8,
    unknown: u8,
}

#[derive(Serialize)]
struct Inventory<'a> {
    schema: &'static str,
    as_of: &'a str,
    origin: Origin,
    exclusions: &'a IndexMap<String, usize>,
    entries: &'a [ConversationEntry],
    typed: &'a [TypedEntry],
    typed_lifecycle: &'a [Value],
}

#[derive(Serialize)]
struct HashedInventory<'a> {
    schema: &'static str,
    origin_version: &'static str,
    exclusions: &'a IndexMap<String, usize>,
    entries: &'a [ConversationEntry],
    typed: &'a [TypedEntry],
    typed_lifecycle: &'a [Value],
    history: [Value; 0],
}

pub(super) struct SourceInventory {
    pub value: Value,
    pub hash: String,
    pub source_count: usize,
    pub canonical_revision: i64,
}

pub(super) fn read(
    data_root: &Path,
    canonical_path: &Path,
    as_of: &str,
    cancellation: &CancellationToken,
) -> CognitionResult<SourceInventory> {
    if cancellation.is_cancelled() {
        return Err(error("memory_operation_aborted"));
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
    let reader = ConversationSourceReader::open(canonical_path)
        .map_err(|_| error("memory_inventory_incomplete"))?;
    let request = RecallRequest {
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
    };
    let deadline = millis().saturating_add(60_000);
    let collation =
        LocaleCollation::new("en-US").map_err(|_| error("memory_inventory_incomplete"))?;
    let scanned = read_canonical_inventory(
        Some(&reader),
        &request,
        deadline,
        &|date| {
            crate::js_date::parse_date_millis(date, &|value| Some(value))
                .map(|value| value as f64)
                .unwrap_or(f64::NAN)
        },
        &|left, right| collation.compare(left, right),
        millis,
    )?;
    reader
        .close()
        .map_err(|_| error("memory_inventory_incomplete"))?;
    if !scanned.available || scanned.partial || cancellation.is_cancelled() {
        return Err(error("memory_inventory_incomplete"));
    }
    // JS prepare classifies historical unknown origins first. This native
    // packet preserves the original canonical bytes, so unclassified origins
    // require an explicit source repair rather than silently excluding them.
    if scanned
        .exclusions
        .get("unknown_origin")
        .copied()
        .unwrap_or(0)
        > 0
    {
        return Err(error("memory_source_origin_unclassified"));
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
        .collect::<Vec<_>>();
    let (typed, typed_lifecycle) = typed_registry(data_root, cancellation, &collation)?;
    let hash_material = HashedInventory {
        schema: "butler.memory-source-inventory.v1",
        origin_version: "conversation-origin-v1",
        exclusions: &exclusions,
        entries: &entries,
        typed: &typed,
        typed_lifecycle: &typed_lifecycle,
        history: [],
    };
    let hash = digest(
        &serde_json::to_vec(&hash_material).map_err(|_| error("memory_inventory_incomplete"))?,
    );
    let source_count = entries
        .iter()
        .map(|entry| entry.source_unit_count)
        .sum::<usize>()
        + typed
            .iter()
            .map(|entry| entry.source_ids.len())
            .sum::<usize>();
    let value = serde_json::to_value(Inventory {
        schema: "butler.memory-source-inventory.v1",
        as_of,
        origin: Origin {
            version: "conversation-origin-v1",
            applied: 0,
            unchanged: 0,
            unknown: 0,
        },
        exclusions: &exclusions,
        entries: &entries,
        typed: &typed,
        typed_lifecycle: &typed_lifecycle,
    })
    .map_err(|_| error("memory_inventory_incomplete"))?;
    let connection = Connection::open_with_flags(canonical_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| error("memory_inventory_incomplete"))?;
    let canonical_revision = connection
        .query_row(
            "SELECT revision FROM conversation_public_source_state WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(|_| error("memory_inventory_incomplete"))?;
    Ok(SourceInventory {
        value,
        hash,
        source_count,
        canonical_revision,
    })
}

fn typed_registry(
    data_root: &Path,
    cancellation: &CancellationToken,
    collation: &LocaleCollation,
) -> CognitionResult<(Vec<TypedEntry>, Vec<Value>)> {
    let tasks = WorkRecordReader::new(data_root);
    let mut task_ids = tasks
        .task_ids()
        .map_err(|_| error("memory_source_unavailable"))?;
    task_ids.sort();
    let mut typed = Vec::new();
    let mut lifecycle = Vec::new();
    for task_id in task_ids {
        if cancellation.is_cancelled() {
            return Err(error("memory_operation_aborted"));
        }
        let report = tasks
            .read_memory_report(&task_id, ReadAvailability::Strict)
            .map_err(|_| error("memory_source_unavailable"))?;
        let Some(report) = report else {
            continue;
        };
        let record = read_task_report(data_root, &task_memory_record_id(&task_id))?
            .ok_or_else(|| error("memory_source_unavailable"))?;
        typed.push(entry(record)?);
        let binding_path = data_root
            .join("tasks")
            .join(&task_id)
            .join("memory-report-binding.json");
        let mut binding: Value = serde_json::from_slice(
            &fs::read(binding_path).map_err(|_| error("memory_source_unavailable"))?,
        )
        .map_err(|_| error("memory_source_unavailable"))?;
        binding
            .as_object_mut()
            .ok_or_else(|| error("memory_source_unavailable"))?
            .insert("text".into(), Value::String(report.text));
        lifecycle.push(json!({"source_kind":"task_report","task_id":task_id,"report":binding}));
    }
    let rules = data_root.join("cognition/memory/rules");
    if rules.is_dir() {
        let mut names = fs::read_dir(&rules)
            .map_err(|_| error("memory_source_unavailable"))?
            .map(|item| item.map(|value| value.file_name().to_string_lossy().into_owned()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| error("memory_source_unavailable"))?;
        names.sort();
        for name in names
            .into_iter()
            .filter(|name| name.ends_with(".source.json"))
        {
            if cancellation.is_cancelled() {
                return Err(error("memory_operation_aborted"));
            }
            let record_id = name.trim_end_matches(".source.json");
            let bytes =
                fs::read(rules.join(&name)).map_err(|_| error("memory_source_unavailable"))?;
            let binding: Value =
                serde_json::from_slice(&bytes).map_err(|_| error("memory_source_unavailable"))?;
            if binding["schema"] != "butler.explicit-rule-binding.v1"
                || binding["record_id"] != record_id
            {
                continue;
            }
            if let Some(record) =
                read_explicit_record(&data_root.join("cognition/memory"), record_id)?
            {
                typed.push(entry(record)?);
            }
            lifecycle.push(
                json!({"source_kind":"explicit_record","record_id":record_id,"binding":binding}),
            );
        }
    }
    let quality = data_root.join("cognition/feedback/quality-operations.jsonl");
    let mut operations = Vec::new();
    if quality.is_file() {
        let content =
            fs::read_to_string(quality).map_err(|_| error("memory_source_unavailable"))?;
        for line in content.trim().lines() {
            if let Ok(value) = serde_json::from_str::<Value>(line)
                && value["schema"] == "butler.memory-source-quality-operation.v1"
            {
                operations.push(value);
            }
        }
        operations.sort_by(|a, b| {
            collation.compare(
                a["operation_id"].as_str().unwrap_or(""),
                b["operation_id"].as_str().unwrap_or(""),
            )
        });
    }
    lifecycle.push(json!({"source_kind":"feedback_quality_operations","operations":operations}));
    typed.sort_by(|a, b| {
        collation.compare(
            &format!("{}\0{}", a.source_kind, a.record_id),
            &format!("{}\0{}", b.source_kind, b.record_id),
        )
    });
    lifecycle.sort_by(|a, b| collation.compare(&a.to_string(), &b.to_string()));
    Ok((typed, lifecycle))
}

fn entry(record: crate::cognition::sources::TypedMemoryRecord) -> CognitionResult<TypedEntry> {
    let episode = crate::cognition::sources::projection_hash_for_graph(vec![
        json!("typed-memory-record"),
        json!(record.source_kind),
        json!(record.record_id),
    ])
    .map_err(|_| error("memory_inventory_incomplete"))?;
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
            .map_err(|_| error("memory_inventory_incomplete"))?,
        );
    }
    Ok(TypedEntry {
        source_kind: record.source_kind,
        record_kind: record.record_kind,
        record_id: record.record_id,
        revision: record.revision,
        operation_id: record.operation_id,
        content_hash: record.content_hash,
        project_id: record.project_id,
        conversation_session_id: record.conversation_session_id,
        conversation_message_id: record.conversation_message_id,
        observed_at: record.observed_at,
        role: record.role,
        basis: record.basis,
        lifecycle: "current",
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
fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
