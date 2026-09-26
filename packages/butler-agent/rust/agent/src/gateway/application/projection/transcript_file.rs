//! Transcript file identity, bounded byte-window reads, and checkpoint reuse.

use std::{path::PathBuf, time::UNIX_EPOCH};

use sha2::{Digest, Sha256};

use super::{ProjectionContext, checkpoint::Checkpoint};
use crate::gateway::application::{GatewayApplicationError, app_error};

pub(in crate::gateway::application) async fn sync_chat_once(
    context: &ProjectionContext,
    chat_id: &str,
) -> Result<bool, GatewayApplicationError> {
    let session_id = super::super::native_preparation::session_hint(chat_id);
    let file_name = format!(
        "{}.jsonl",
        session_id.replace(
            |ch: char| !ch.is_ascii_alphanumeric() && !"._-".contains(ch),
            "_"
        )
    );
    let path = context.butler_data.join("transcripts").join(file_name);
    let chat = chat_id.to_owned();
    let prior = context
        .storage
        .execute(move |db| super::checkpoint::load(db, &chat))
        .await
        .map_err(app_error)?;
    let path_for_read = path.clone();
    let state = tokio::task::spawn_blocking(move || file_state(&path_for_read))
        .await
        .map_err(|_| GatewayApplicationError::Internal)??;
    let Some(state) = state else { return Ok(false) };
    let spool_path = spool_path(&context.butler_data, chat_id, &path);
    let mut checkpoint = prior
        .clone()
        .filter(|value| {
            super::byte_window::reusable(value, &path, (state.device, state.inode), state.size)
        })
        .unwrap_or_else(|| fresh_checkpoint(chat_id, &session_id, &path, &spool_path, &state));
    if checkpoint.spool_path.is_empty() {
        checkpoint.spool_path = spool_path.to_string_lossy().into_owned();
    }
    if let Some(stale) = prior
        .as_ref()
        .filter(|value| value.spool_bytes > 0 && value.spool_path != checkpoint.spool_path)
    {
        let _ = tokio::fs::remove_file(PathBuf::from(&stale.spool_path)).await;
    }
    let mut read = tokio::task::spawn_blocking(move || {
        super::byte_window::read_record(checkpoint, state.size, state.modified_at_ms)
    })
    .await
    .map_err(|_| GatewayApplicationError::Internal)?
    .map_err(app_error)?;
    if read.checkpoint.spool_bytes == 0 {
        read.checkpoint.spool_path.clear();
    }
    let pending = read.pending;
    let completed = read.completed_spool.clone();
    let advanced = match read.event {
        None => {
            super::save_checkpoint(context, read.checkpoint).await?;
            true
        }
        Some(event) => super::project_event(context, chat_id, event, read.checkpoint).await?,
    };
    if let Some(path) = completed {
        let _ = tokio::fs::remove_file(path).await;
    }
    // An unproven old claim retains its original event and yields this sync.
    // Reporting pending here would replay that same record in a tight loop.
    Ok(advanced && pending)
}

struct FileState {
    size: u64,
    modified_at_ms: f64,
    device: u64,
    inode: u64,
}
fn file_state(path: &std::path::Path) -> Result<Option<FileState>, GatewayApplicationError> {
    let metadata = match std::fs::metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(GatewayApplicationError::Internal),
    };
    if !metadata.is_file() {
        return Ok(None);
    }
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    #[cfg(unix)]
    let (device, inode) = (metadata.dev(), metadata.ino());
    #[cfg(not(unix))]
    let (device, inode) = (0, 0);
    let modified_at_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |value| value.as_secs_f64() * 1000.0);
    Ok(Some(FileState {
        size: metadata.len(),
        modified_at_ms,
        device,
        inode,
    }))
}
fn fresh_checkpoint(
    chat: &str,
    session: &str,
    path: &std::path::Path,
    spool: &std::path::Path,
    state: &FileState,
) -> Checkpoint {
    Checkpoint {
        chat_id: chat.into(),
        session_id: session.into(),
        path: path.to_string_lossy().into_owned(),
        device: state.device,
        inode: state.inode,
        projected_bytes: 0,
        modified_at_ms: state.modified_at_ms,
        trailing: Vec::new(),
        boundary_anchor: Vec::new(),
        spool_path: spool.to_string_lossy().into_owned(),
        spool_bytes: 0,
        spool_end_offset: 0,
    }
}
fn spool_path(data: &std::path::Path, chat: &str, path: &std::path::Path) -> PathBuf {
    let mut hash = Sha256::new();
    hash.update(chat.as_bytes());
    hash.update([0]);
    hash.update(path.to_string_lossy().as_bytes());
    data.join("transcript-projection-spool")
        .join(format!("{:x}.json", hash.finalize()))
}
