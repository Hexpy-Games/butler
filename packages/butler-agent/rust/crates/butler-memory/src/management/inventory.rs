use super::{MemoryCard, MemoryInventory, measurement::files};
use crate::cognition::CognitionPathEnvironment;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Value, json};
use std::{io, path::Path};
use tokio_util::sync::CancellationToken;

pub(super) fn unknown(revision: u64) -> MemoryInventory {
    MemoryInventory {
        state: "not_measured".into(),
        revision,
        measured_at: None,
        kinds: [
            ("pinned", "active_handles"),
            ("automatic", "conversation_episodes"),
            ("profile", "stable_entries"),
            ("project", "capsules"),
        ]
        .into_iter()
        .map(|(kind, unit)| MemoryCard {
            kind: kind.into(),
            count_unit: unit.into(),
            item_count: None,
            pending_count: None,
            allocated_bytes: None,
            content_updated_at: None,
            health: json!({"state":"not_measured"}),
        })
        .collect(),
        dead_letter_allocated_bytes: None,
    }
}

pub(super) fn measure(
    root: &Path,
    paths: &CognitionPathEnvironment,
    revision: u64,
    now: String,
    health: &Value,
    token: &CancellationToken,
) -> io::Result<MemoryInventory> {
    let mut result = unknown(revision);
    let memory = paths.memory_root(root);
    let pinned = files(&memory.join("rules"), token)?;
    let projects = files(&memory.join("projects"), token)?;
    let profile = files(&root.join("cognition/profile"), token)?;
    let mut automatic_bytes = Some(0_u64);
    for child in [
        "generations",
        "queue",
        "db",
        "hot",
        "conversations",
        "management",
    ] {
        automatic_bytes = automatic_bytes
            .zip(files(&memory.join(child), token)?.bytes)
            .map(|(sum, bytes)| sum.saturating_add(bytes));
    }
    for card in &mut result.kinds {
        match card.kind.as_str() {
            "pinned" => {
                card.allocated_bytes = pinned.bytes;
                // The approved handle index is not installed yet. Files are not active handles.
                card.item_count = (!memory.join("rules").exists()).then_some(0);
                card.health = json!({"state": if card.item_count.is_some() {"empty"} else {"active_index_unavailable"}});
            }
            "project" => {
                card.allocated_bytes = projects.bytes;
                card.item_count = Some(projects.markdown);
                card.content_updated_at = projects.latest.clone();
                card.health = json!({"refresh_failures_allocated_bytes": files(&memory.join("projects/.refresh-failures.jsonl"), token)?.bytes});
            }
            "profile" => {
                card.allocated_bytes = profile.bytes;
                read_profile(root, card)?;
            }
            "automatic" => {
                card.allocated_bytes = automatic_bytes;
                card.health = health.clone();
                if let Some(health) = card.health.as_object_mut() {
                    health.insert(
                        "reclaimable_bytes".into(),
                        serde_json::to_value(reclaimable(root, paths, token)?)
                            .map_err(io::Error::other)?,
                    );
                }
                read_automatic(root, paths, card)?;
            }
            _ => {}
        }
    }
    result.dead_letter_allocated_bytes =
        files(&memory.join("queue/dead-letter.jsonl"), token)?.bytes;
    super::safety::cancelled(token)?;
    result.state = "measured".into();
    result.measured_at = Some(now);
    Ok(result)
}

fn open(path: &Path) -> io::Result<Connection> {
    butler_platform::sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(io::Error::other)
}

fn read_profile(root: &Path, card: &mut MemoryCard) -> io::Result<()> {
    let path = root.join("cognition/profile/profile.sqlite");
    if !path.exists() {
        card.item_count = Some(0);
        card.pending_count = Some(0);
        card.health = json!({"consent_on":false,"state":"not_collected"});
        return Ok(());
    }
    let db = open(&path)?;
    card.item_count = Some(
        db.query_row("SELECT COUNT(*) FROM stable_profile_entries", [], |r| {
            r.get(0)
        })
        .map_err(io::Error::other)?,
    );
    card.pending_count = Some(
        db.query_row(
            "SELECT COUNT(*) FROM profile_candidates WHERE status='candidate'",
            [],
            |r| r.get(0),
        )
        .map_err(io::Error::other)?,
    );
    card.content_updated_at = db.query_row("SELECT MAX(updated_at) FROM (SELECT updated_at FROM stable_profile_entries UNION ALL SELECT updated_at FROM profile_candidates)", [], |r| r.get(0)).map_err(io::Error::other)?;
    let mode: Option<String> = db
        .query_row(
            "SELECT value_json FROM profile_meta WHERE key='mode'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(io::Error::other)?;
    let consent = mode
        .as_deref()
        .and_then(|v| serde_json::from_str::<String>(v).ok())
        .is_some_and(|v| v != "off");
    card.health =
        json!({"consent_on":consent,"state":if consent {"collected"} else {"not_collected"}});
    Ok(())
}

fn read_automatic(
    root: &Path,
    paths: &CognitionPathEnvironment,
    card: &mut MemoryCard,
) -> io::Result<()> {
    if !paths
        .memory_root(root)
        .join("active-generation.json")
        .exists()
    {
        card.item_count = (!paths.memory_root(root).join("db").exists()).then_some(0);
        return Ok(());
    }
    let handle = super::safety::active(root, paths)?;
    let db = open(&handle.graph_path)?;
    card.item_count = Some(db.query_row("SELECT COUNT(*) FROM memory_chunks c WHERE c.status='active' AND EXISTS(SELECT 1 FROM memory_chunk_sources s WHERE s.episode_id=c.memory_chunk_id AND s.revision=c.current_revision AND s.source_kind='conversation' AND s.origin_kind IN ('user_input','assistant_public'))", [], |r| r.get(0)).map_err(io::Error::other)?);
    card.content_updated_at = db.query_row("SELECT MAX(c.updated_at) FROM memory_chunks c WHERE EXISTS(SELECT 1 FROM memory_chunk_sources s WHERE s.episode_id=c.memory_chunk_id AND s.revision=c.current_revision AND s.source_kind='conversation')", [], |r| r.get(0)).map_err(io::Error::other)?;
    let missing: u64 = db.query_row("SELECT COUNT(*) FROM memory_chunks c WHERE c.status='active' AND EXISTS(SELECT 1 FROM memory_chunk_sources s WHERE s.episode_id=c.memory_chunk_id AND s.revision=c.current_revision AND s.source_kind='conversation' AND s.origin_kind IN ('user_input','assistant_public')) AND EXISTS(SELECT 1 FROM memory_projection_jobs j JOIN memory_vector_units u ON u.job_id=j.job_id WHERE j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision AND u.state NOT IN ('complete','superseded'))", [], |r| r.get(0)).map_err(io::Error::other)?;
    let object = card
        .health
        .as_object_mut()
        .ok_or_else(|| io::Error::other("Health unavailable"))?;
    object.insert(
        "conversation_episodes_without_vectors".into(),
        json!(missing),
    );
    Ok(())
}

fn reclaimable(
    root: &Path,
    paths: &CognitionPathEnvironment,
    token: &CancellationToken,
) -> io::Result<Option<u64>> {
    let memory = paths.memory_root(root);
    if !memory.join("active-generation.json").exists() {
        return Ok(None);
    }
    let active = super::safety::active(root, paths)?;
    let descriptor = std::fs::read(memory.join("active-generation.json"))?;
    let manifest = std::fs::read(active.root.join("manifest.json"))?;
    super::cleanup::plan::analyze(
        &memory,
        &active.generation_id,
        &descriptor,
        &manifest,
        token,
    )?
    .into_iter()
    .filter(|item| item.reason == "unpublished_empty_generation")
    .try_fold(Some(0_u64), |total, item| {
        Ok(total
            .zip(item.allocated_bytes)
            .map(|(a, b)| a.saturating_add(b)))
    })
}
