//! Short-lived witnesses retained across qualification preparation.
//!
//! [`LiveWitness`] records the live canonical store and typed source files;
//! [`CandidateWitness`] records a candidate's manifest, graph, Lance table,
//! snapshot, and hot cache. Each `assert_current` fails when anything it
//! recorded has changed since `open`.

use crate::cognition::CognitionCode;
use std::{fs, path::Path};

use butler_platform::secure_fs::{self, FileId, FileTime};

use lancedb::{Error as LanceError, Table};
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};

use super::manifest::{
    AcceptanceBinding, CanonicalSnapshot, EmbeddingSlot, GenerationManifest, GenerationState,
};
use crate::cognition::{
    CognitionError, CognitionResult, MemoryGenerationHandle, ensure_data_authority, lance_store,
};

/// Largest hot cache a candidate may retain.
const MAX_CACHE_BYTES: u64 = 20 * 1024;

/// Inode-level identity of a file: any rewrite changes it. Hosts without
/// file ids compare length and times only.
#[derive(Clone, Debug, PartialEq, Eq)]
struct FileIdentity {
    id: Option<FileId>,
    bytes: u64,
    modified: Option<FileTime>,
    changed: Option<FileTime>,
}

/// Identities of one task's memory-relevant files.
#[derive(Debug, PartialEq, Eq)]
struct TaskFacts {
    task_id: String,
    files: Vec<(&'static str, Option<FileIdentity>)>,
    attempts: Vec<String>,
    latest_result: Option<FileIdentity>,
}

/// Identities of every typed source outside the canonical store.
#[derive(Debug, PartialEq, Eq)]
struct TypedFacts {
    tasks: Vec<TaskFacts>,
    rules: Vec<(String, Option<FileIdentity>)>,
    project_registry: Option<FileIdentity>,
    feedback: Option<FileIdentity>,
    feedback_quality: Option<FileIdentity>,
}

pub(super) struct LiveWitness {
    canonical: Connection,
    canonical_identity: FileIdentity,
    canonical_data_version: i64,
    typed: TypedFacts,
    data_root: std::path::PathBuf,
}

impl LiveWitness {
    pub(super) fn open(data_root: &Path) -> CognitionResult<Self> {
        let canonical_path = data_root.join("runtime/conversation-store.sqlite");
        ensure_data_authority(
            data_root,
            &[
                &canonical_path,
                &data_root.join("tasks"),
                &data_root.join("cognition/memory/rules"),
                &data_root.join("cognition/feedback"),
                &data_root.join("butler.config.json"),
            ],
        )?;
        let canonical_identity = identity(&canonical_path)?
            .ok_or_else(|| error(CognitionCode::MemoryInventoryChanged))?;
        let canonical =
            Connection::open_with_flags(&canonical_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|source| {
                    error(CognitionCode::MemoryInventoryChanged).with_source(source)
                })?;
        let canonical_data_version =
            data_version(&canonical, CognitionCode::MemoryInventoryChanged)?;
        Ok(Self {
            canonical,
            canonical_identity,
            canonical_data_version,
            typed: typed_facts(data_root)?,
            data_root: data_root.to_owned(),
        })
    }

    pub(super) fn assert_current(&self) -> CognitionResult<()> {
        let canonical_path = self.data_root.join("runtime/conversation-store.sqlite");
        let data_version = data_version(&self.canonical, CognitionCode::MemoryInventoryChanged)?;
        if identity(&canonical_path)?.as_ref() != Some(&self.canonical_identity)
            || data_version != self.canonical_data_version
            || typed_facts(&self.data_root)? != self.typed
        {
            return Err(error(CognitionCode::MemoryInventoryChanged));
        }
        Ok(())
    }

    pub(super) fn assert_public_revision(&self, expected: i64) -> CognitionResult<()> {
        let revision: i64 = self
            .canonical
            .query_row(
                "SELECT revision FROM conversation_public_source_state WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .map_err(|source| error(CognitionCode::MemorySourceChanged).with_source(source))?;
        if revision != expected {
            return Err(error(CognitionCode::MemorySourceChanged));
        }
        Ok(())
    }
}

fn data_version(connection: &Connection, code: CognitionCode) -> CognitionResult<i64> {
    connection
        .query_row("PRAGMA main.data_version", [], |row| row.get(0))
        .map_err(|source| error(code).with_source(source))
}

/// Task files whose change can change a task's memory report.
const TASK_FILES: [&str; 7] = [
    "status",
    "request.md",
    "result.md",
    "plan.json",
    "review.json",
    "public-report.md",
    "memory-report-binding.json",
];

fn typed_facts(data_root: &Path) -> CognitionResult<TypedFacts> {
    let tasks_root = data_root.join("tasks");
    let mut tasks = Vec::new();
    for task in entries(&tasks_root)? {
        let root = tasks_root.join(&task);
        if root.is_dir() {
            tasks.push(task_facts(&root, task)?);
        }
    }
    let rules_root = data_root.join("cognition/memory/rules");
    let mut rules = Vec::new();
    for name in entries(&rules_root)?
        .into_iter()
        .filter(|name| name.ends_with(".md") || name.ends_with(".source.json"))
    {
        let file = identity(&rules_root.join(&name))?;
        rules.push((name, file));
    }
    Ok(TypedFacts {
        tasks,
        rules,
        project_registry: identity(&data_root.join("butler.config.json"))?,
        feedback: identity(&data_root.join("cognition/feedback/feedback.md"))?,
        feedback_quality: identity(&data_root.join("cognition/feedback/quality-operations.jsonl"))?,
    })
}

fn task_facts(root: &Path, task_id: String) -> CognitionResult<TaskFacts> {
    let attempts_root = root.join("attempts");
    let attempts = entries(&attempts_root)?;
    let latest_result = match attempts.last() {
        Some(attempt) => identity(&attempts_root.join(attempt).join("result.md"))?,
        None => None,
    };
    let mut files = Vec::with_capacity(TASK_FILES.len());
    for file in TASK_FILES {
        files.push((file, identity(&root.join(file))?));
    }
    Ok(TaskFacts {
        task_id,
        files,
        attempts,
        latest_result,
    })
}

fn entries(root: &Path) -> CognitionResult<Vec<String>> {
    let values = match fs::read_dir(root) {
        Ok(value) => value,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(error(CognitionCode::MemoryInventoryChanged)),
    };
    let mut names = values
        .map(|entry| {
            entry
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .map_err(|source| error(CognitionCode::MemoryInventoryChanged).with_source(source))
        })
        .collect::<CognitionResult<Vec<_>>>()?;
    names.sort();
    Ok(names)
}

/// The manifest facts a candidate's qualification depends on.
#[derive(Debug, PartialEq)]
struct ManifestFacts {
    generation_id: Option<String>,
    state: Option<GenerationState>,
    canonical_snapshot_id: Option<String>,
    canonical_snapshot_path: Option<String>,
    canonical_snapshot: Option<CanonicalSnapshot>,
    source_inventory_hash: Option<String>,
    extraction_version: Option<String>,
    embedding: Option<EmbeddingSlot>,
    readiness_sha256: Option<String>,
    required_acceptance_passed: Option<bool>,
    acceptance_binding: Option<AcceptanceBinding>,
}

impl From<GenerationManifest> for ManifestFacts {
    fn from(manifest: GenerationManifest) -> Self {
        Self {
            generation_id: manifest.generation_id,
            state: manifest.state,
            canonical_snapshot_id: manifest.canonical_snapshot_id,
            canonical_snapshot_path: manifest.canonical_snapshot_path,
            canonical_snapshot: manifest.canonical_snapshot,
            source_inventory_hash: manifest.source_inventory_hash,
            extraction_version: manifest.extraction_version,
            embedding: manifest.embedding,
            readiness_sha256: manifest.readiness.and_then(|readiness| readiness.sha256),
            required_acceptance_passed: manifest.required_acceptance_passed,
            acceptance_binding: manifest.acceptance_binding,
        }
    }
}

/// Everything a candidate witness compares.
#[derive(Debug, PartialEq)]
struct CandidateFacts {
    manifest: ManifestFacts,
    graph: Option<FileIdentity>,
    graph_data_version: i64,
    lance_root: Option<FileIdentity>,
    lance_version: Option<u64>,
    snapshot: Option<FileIdentity>,
    cache: Option<FileIdentity>,
    cache_sha256: Option<String>,
}

pub(super) struct CandidateWitness {
    graph: Connection,
    table: Option<Table>,
    initial: CandidateFacts,
}

impl CandidateWitness {
    pub(super) async fn open(
        data_root: &Path,
        handle: &MemoryGenerationHandle,
    ) -> CognitionResult<Self> {
        let manifest = handle.root.join("manifest.json");
        let cache = handle.root.join("hot/cache.md");
        let lance = handle.root.join("butler.lance");
        let table_root = lance.join("butler_memory.lance");
        let mut paths: Vec<&Path> = vec![
            &handle.root,
            &manifest,
            &handle.graph_path,
            &cache,
            &lance,
            &table_root,
        ];
        if let Some(snapshot) = handle.canonical_snapshot_path.as_deref() {
            paths.push(snapshot);
        }
        ensure_data_authority(data_root, &paths)?;
        let graph =
            Connection::open_with_flags(&handle.graph_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|source| {
                    error(CognitionCode::MemoryGenerationChanged).with_source(source)
                })?;
        let table = open_table(&lance).await?;
        let initial = facts(&graph, table.as_ref(), handle).await?;
        Ok(Self {
            graph,
            table,
            initial,
        })
    }

    pub(super) async fn assert_current(
        &self,
        handle: &MemoryGenerationHandle,
    ) -> CognitionResult<()> {
        if facts(&self.graph, self.table.as_ref(), handle).await? != self.initial {
            return Err(error(CognitionCode::MemoryGenerationChanged));
        }
        Ok(())
    }
}

async fn open_table(lance: &Path) -> CognitionResult<Option<Table>> {
    if !lance.exists() {
        return Ok(None);
    }
    let connection = lance_store::connect(lance)
        .await
        .map_err(|source| error(CognitionCode::MemoryGenerationChanged).with_source(source))?;
    match lance_store::open(&connection, "butler_memory").await {
        Ok(table) => Ok(Some(table)),
        Err(LanceError::TableNotFound { .. }) => Ok(None),
        Err(_) => Err(error(CognitionCode::MemoryGenerationChanged)),
    }
}

async fn facts(
    graph: &Connection,
    table: Option<&Table>,
    handle: &MemoryGenerationHandle,
) -> CognitionResult<CandidateFacts> {
    if let Some(table) = table {
        table
            .checkout_latest()
            .await
            .map_err(|source| error(CognitionCode::MemoryGenerationChanged).with_source(source))?;
    }
    let manifest = GenerationManifest::read(
        &handle.root.join("manifest.json"),
        CognitionCode::MemoryGenerationChanged,
    )?;
    let cache = handle.root.join("hot/cache.md");
    let cache_identity = identity(&cache)?;
    let cache_sha256 = match &cache_identity {
        Some(file) if file.bytes > MAX_CACHE_BYTES => {
            return Err(error(CognitionCode::MemoryGenerationNotReady));
        }
        Some(_) => Some(format!(
            "{:x}",
            Sha256::digest(fs::read(&cache).map_err(|source| {
                error(CognitionCode::MemoryGenerationChanged).with_source(source)
            })?)
        )),
        None => None,
    };
    let lance_version =
        match table {
            Some(table) => Some(table.version().await.map_err(|source| {
                error(CognitionCode::MemoryGenerationChanged).with_source(source)
            })?),
            None => None,
        };
    Ok(CandidateFacts {
        manifest: manifest.into(),
        graph: identity(&handle.graph_path)?,
        graph_data_version: data_version(graph, CognitionCode::MemoryGenerationChanged)?,
        lance_root: identity(&handle.root.join("butler.lance"))?,
        lance_version,
        snapshot: match handle.canonical_snapshot_path.as_deref() {
            Some(path) => identity(path)?,
            None => None,
        },
        cache: cache_identity,
        cache_sha256,
    })
}

fn identity(path: &Path) -> CognitionResult<Option<FileIdentity>> {
    match fs::metadata(path) {
        Ok(item) => {
            let platform = secure_fs::identity(&item);
            Ok(Some(FileIdentity {
                id: platform.id,
                bytes: item.len(),
                modified: platform.modified,
                changed: platform.changed,
            }))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(error(CognitionCode::MemoryGenerationChanged)),
    }
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
