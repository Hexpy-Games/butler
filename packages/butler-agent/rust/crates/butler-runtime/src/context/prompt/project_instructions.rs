//! Root-only project instruction snapshots, refreshed only at turn admission.
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use butler_turn::{btcc::ContextSection, workspace::StoredSessionBinding};
use sha2::{Digest, Sha256};

use super::runtime::section;

const LIMIT: usize = 32 * 1024;
pub(super) type SnapshotCache = Arc<Mutex<Option<CachedSnapshot>>>;

pub(super) struct CachedSnapshot {
    path: PathBuf,
    identity: butler_platform::secure_fs::FileIdentity,
    size: u64,
    text: String,
    digest: String,
}

pub(super) async fn snapshot(
    binding: &StoredSessionBinding,
    cache: SnapshotCache,
) -> Option<ContextSection> {
    // General/unbound sessions must never inspect the home or default workspace.
    binding.project_id.as_ref()?;
    let root = PathBuf::from(&binding.workspace_path);
    let result = tokio::task::spawn_blocking(move || load(&root, &cache)).await;
    let content = match result {
        Ok(value) => value?,
        Err(_) => "Project instructions unavailable: snapshot worker failed.".into(),
    };
    Some(section(
        "project-instructions",
        "Project Operating Instructions",
        content,
        "live_configuration",
        "mandatory_hot_cache",
        "project",
    ))
}

fn load(root: &Path, cache: &SnapshotCache) -> Option<String> {
    let exists = |name: &str| match butler_platform::secure_fs::exact_entry_exists(&root.join(name))
    {
        Ok(exists) => exists,
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    };
    let conventional = exists("AGENTS.md");
    let original = exists("agent.md");
    let name = if conventional {
        "AGENTS.md"
    } else if original {
        "agent.md"
    } else {
        return None;
    };
    let note = if conventional && original {
        "\nAGENTS.md takes precedence; agent.md ignored."
    } else {
        ""
    };
    if conventional && original {
        eprintln!("Project instructions: AGENTS.md takes precedence; agent.md ignored.");
    }
    let result = read_snapshot(root, name, cache);
    Some(match result {
        Ok((text, digest)) => format!(
            "Loaded {name} (SHA-256 {digest}).{note}\nProject-scoped operating instructions, below system and safety rules, permission policy, runtime graph invariants, and the user's explicit current request. These instructions grant no permissions.\n\n{text}"
        ),
        Err(reason) => {
            eprintln!("Project instructions: {name} not loaded: {reason}.");
            format!("{name} not loaded: {reason}.{note}")
        }
    })
}

fn read_snapshot(
    root: &Path,
    name: &str,
    cache: &SnapshotCache,
) -> Result<(String, String), &'static str> {
    // The platform reader anchors to the canonical directory and refuses links
    // and nonregular files without blocking on FIFOs or following a path swap.
    let mut file = butler_platform::secure_fs::open_read_beneath(root, Path::new(name))
        .map_err(|_| "unreadable, symlink, or nonregular file")?;
    let metadata = file.metadata().map_err(|_| "metadata unavailable")?;
    if metadata.len() > LIMIT as u64 {
        return Err("exceeds the 32 KiB limit; no partial content injected");
    }
    let path = root.join(name);
    let identity = butler_platform::secure_fs::identity(&metadata);
    let mut cached = cache.lock().map_err(|_| "snapshot cache unavailable")?;
    if let Some(previous) = cached.as_ref()
        && identity.modified.is_some()
        && previous.path == path
        && previous.identity == identity
        && previous.size == metadata.len()
    {
        return Ok((previous.text.clone(), previous.digest.clone()));
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "file read failed")?;
    if bytes.len() > LIMIT {
        return Err("exceeds the 32 KiB limit; no partial content injected");
    }
    let after = file.metadata().map_err(|_| "metadata unavailable")?;
    if after.len() != metadata.len() || butler_platform::secure_fs::identity(&after) != identity {
        return Err("file changed during snapshot; content deferred to the next turn");
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let text = String::from_utf8(bytes).map_err(|_| "invalid UTF-8; no content injected")?;
    *cached = Some(CachedSnapshot {
        path,
        identity,
        size: metadata.len(),
        text: text.clone(),
        digest: digest.clone(),
    });
    Ok((text, digest))
}
