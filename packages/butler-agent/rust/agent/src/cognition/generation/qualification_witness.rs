//! Short-lived candidate witness retained across qualification preparation.

use std::{fs, os::unix::fs::MetadataExt, path::Path};

use lancedb::{Error as LanceError, Table};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::cognition::{
    CognitionError, CognitionResult, MemoryGenerationHandle, ensure_data_authority, lance_store,
};

pub(super) struct LiveWitness {
    canonical: Connection,
    canonical_identity: Value,
    canonical_data_version: i64,
    typed: Value,
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
        let canonical_identity =
            metadata(&canonical_path)?.ok_or_else(|| error("memory_inventory_changed"))?;
        let canonical =
            Connection::open_with_flags(&canonical_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| error("memory_inventory_changed"))?;
        let canonical_data_version = canonical
            .query_row("PRAGMA main.data_version", [], |row| row.get(0))
            .map_err(|_| error("memory_inventory_changed"))?;
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
        let data_version: i64 = self
            .canonical
            .query_row("PRAGMA main.data_version", [], |row| row.get(0))
            .map_err(|_| error("memory_inventory_changed"))?;
        if metadata(&canonical_path)?.as_ref() != Some(&self.canonical_identity)
            || data_version != self.canonical_data_version
            || typed_facts(&self.data_root)? != self.typed
        {
            return Err(error("memory_inventory_changed"));
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
            .map_err(|_| error("memory_source_changed"))?;
        if revision != expected {
            return Err(error("memory_source_changed"));
        }
        Ok(())
    }
}

fn typed_facts(data_root: &Path) -> CognitionResult<Value> {
    let tasks = data_root.join("tasks");
    let mut task_facts = Vec::new();
    for task in entries(&tasks)? {
        let root = tasks.join(&task);
        if !root.is_dir() {
            continue;
        }
        let attempts_root = root.join("attempts");
        let attempts = entries(&attempts_root)?;
        let latest = attempts
            .last()
            .map(|attempt| attempts_root.join(attempt).join("result.md"));
        let files = [
            "status",
            "request.md",
            "result.md",
            "plan.json",
            "review.json",
            "public-report.md",
            "memory-report-binding.json",
        ];
        let mut identities = Vec::new();
        for file in files {
            identities.push((file, metadata(&root.join(file))?));
        }
        task_facts.push(
            json!({"task_id":task,"files":identities,"attempts":attempts,
            "latest_result":match latest {Some(path)=>metadata(&path)?,None=>None}}),
        );
    }
    let rules_root = data_root.join("cognition/memory/rules");
    let mut rules = Vec::new();
    for name in entries(&rules_root)?
        .into_iter()
        .filter(|name| name.ends_with(".md") || name.ends_with(".source.json"))
    {
        rules.push(json!([name, metadata(&rules_root.join(&name))?]));
    }
    Ok(json!({"tasks":task_facts,"rules":rules,
        "project_registry":metadata(&data_root.join("butler.config.json"))?,
        "feedback":metadata(&data_root.join("cognition/feedback/feedback.md"))?,
        "feedback_quality":metadata(&data_root.join("cognition/feedback/quality-operations.jsonl"))?}))
}

fn entries(root: &Path) -> CognitionResult<Vec<String>> {
    let values = match fs::read_dir(root) {
        Ok(value) => value,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(error("memory_inventory_changed")),
    };
    let mut names = values
        .map(|entry| {
            entry
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .map_err(|_| error("memory_inventory_changed"))
        })
        .collect::<CognitionResult<Vec<_>>>()?;
    names.sort();
    Ok(names)
}

pub(super) struct CandidateWitness {
    graph: Connection,
    table: Option<Table>,
    initial: Value,
}

impl CandidateWitness {
    pub(super) async fn open(
        data_root: &Path,
        handle: &MemoryGenerationHandle,
    ) -> CognitionResult<Self> {
        let manifest = handle.root.join("manifest.json");
        let cache = handle.root.join("hot/cache.md");
        let lance = handle.root.join("butler.lance");
        let mut paths: Vec<&Path> =
            vec![&handle.root, &manifest, &handle.graph_path, &cache, &lance];
        let table_root = lance.join("butler_memory.lance");
        paths.push(&table_root);
        if let Some(snapshot) = handle.canonical_snapshot_path.as_deref() {
            paths.push(snapshot);
        }
        ensure_data_authority(data_root, &paths)?;
        let graph =
            Connection::open_with_flags(&handle.graph_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| error("memory_generation_changed"))?;
        let table = if lance.exists() {
            let connection = lance_store::connect(&lance)
                .await
                .map_err(|_| error("memory_generation_changed"))?;
            match lance_store::open(&connection, "butler_memory").await {
                Ok(table) => Some(table),
                Err(LanceError::TableNotFound { .. }) => None,
                Err(_) => return Err(error("memory_generation_changed")),
            }
        } else {
            None
        };
        let mut witness = Self {
            graph,
            table,
            initial: Value::Null,
        };
        witness.initial = witness.facts(handle).await?;
        Ok(witness)
    }

    pub(super) async fn assert_current(
        &self,
        handle: &MemoryGenerationHandle,
    ) -> CognitionResult<()> {
        if self.facts(handle).await? != self.initial {
            return Err(error("memory_generation_changed"));
        }
        Ok(())
    }

    async fn facts(&self, handle: &MemoryGenerationHandle) -> CognitionResult<Value> {
        if let Some(table) = &self.table {
            table
                .checkout_latest()
                .await
                .map_err(|_| error("memory_generation_changed"))?;
        }
        let manifest: Value = serde_json::from_slice(
            &fs::read(handle.root.join("manifest.json"))
                .map_err(|_| error("memory_generation_changed"))?,
        )
        .map_err(|_| error("memory_generation_changed"))?;
        let cache = handle.root.join("hot/cache.md");
        let cache_sha = if let Some(metadata) = metadata(&cache)? {
            if metadata["bytes"].as_u64().unwrap_or(u64::MAX) > 20 * 1024 {
                return Err(error("memory_generation_not_ready"));
            }
            Some(format!(
                "{:x}",
                Sha256::digest(fs::read(&cache).map_err(|_| error("memory_generation_changed"))?)
            ))
        } else {
            None
        };
        let graph_data_version: i64 = self
            .graph
            .query_row("PRAGMA main.data_version", [], |row| row.get(0))
            .map_err(|_| error("memory_generation_changed"))?;
        let version = match &self.table {
            Some(table) => Some(
                table
                    .version()
                    .await
                    .map_err(|_| error("memory_generation_changed"))?,
            ),
            None => None,
        };
        Ok(json!({
            "manifest": {
                "generation_id": manifest["generation_id"], "state": manifest["state"],
                "canonical_snapshot_id": manifest["canonical_snapshot_id"],
                "canonical_snapshot_path": manifest["canonical_snapshot_path"],
                "canonical_snapshot": manifest["canonical_snapshot"],
                "source_inventory_hash": manifest["source_inventory_hash"],
                "extraction_version": manifest["extraction_version"], "embedding": manifest["embedding"],
                "readiness_sha256": manifest["readiness"]["sha256"],
                "required_acceptance_passed": manifest["required_acceptance_passed"],
                "acceptance_binding": manifest["acceptance_binding"],
            },
            "graph": metadata(&handle.graph_path)?, "graph_data_version": graph_data_version,
            "lance_root": metadata(&handle.root.join("butler.lance"))?, "lance_version": version,
            "snapshot": match handle.canonical_snapshot_path.as_deref() {
                Some(path) => metadata(path)?, None => None,
            },
            "cache": { "identity": metadata(&cache)?, "sha256": cache_sha },
        }))
    }
}

fn metadata(path: &Path) -> CognitionResult<Option<Value>> {
    match fs::metadata(path) {
        Ok(item) => Ok(Some(
            json!({"dev":item.dev(),"ino":item.ino(),"bytes":item.len(),
            "mtime_sec":item.mtime(),"mtime_nsec":item.mtime_nsec(),
            "ctime_sec":item.ctime(),"ctime_nsec":item.ctime_nsec()}),
        )),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(error("memory_generation_changed")),
    }
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
