//! Transcript file identity, bounded byte-window reads, and checkpoint reuse.

use std::{path::PathBuf, time::UNIX_EPOCH};

use sha2::{Digest, Sha256};

use super::{ProjectionContext, byte_window::ReadBatch, checkpoint::Checkpoint};
use crate::gateway::application::{GatewayApplicationError, app_error};

pub(in crate::gateway::application) async fn sync_chat_once(
    context: &ProjectionContext,
    chat_id: &str,
) -> Result<bool, GatewayApplicationError> {
    let session_id = crate::gateway::application::snapshot_input::session_hint(chat_id);
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
        .map_err(GatewayApplicationError::internal_from)??;
    let Some(state) = state else { return Ok(false) };
    let spool_path = spool_path(&context.butler_data, chat_id, &path);
    let mut checkpoint = match prior.clone() {
        Some(value) if super::byte_window::reusable(&value, &path, state.size) => value,
        found => {
            if found.is_some() {
                eprintln!(
                    "[gateway] transcript checkpoint no longer matches its file; projecting {chat_id} from the start"
                );
            }
            fresh_checkpoint(chat_id, &session_id, &path, &spool_path, &state)
        }
    };
    (checkpoint.device, checkpoint.inode) = (state.device, state.inode);
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
        super::byte_window::read_batch(checkpoint, state.size, state.modified_at_ms)
    })
    .await
    .map_err(GatewayApplicationError::internal_from)?
    .map_err(app_error)?;
    if read.checkpoint.spool_bytes == 0 {
        read.checkpoint.spool_path.clear();
    }
    let pending = read.pending;
    let completed = read.completed_spool.take();
    // A sweep over a chat whose file has not changed writes nothing.
    let unchanged = read.records.is_empty() && prior.as_ref() == Some(&read.checkpoint);
    let advanced = if unchanged {
        true
    } else {
        project_batch(context, chat_id, read).await?
    };
    if let Some(path) = completed {
        let _ = tokio::fs::remove_file(path).await;
    }
    // An unproven old claim retains its original event and yields this sync.
    // Reporting pending here would replay that same record in a tight loop.
    Ok(advanced && pending)
}

/// Records that change projected state are projected one by one, each with
/// its own checkpoint in the same transaction. Every other record only moves
/// the checkpoint, so the batch saves it once at its end.
async fn project_batch(
    context: &ProjectionContext,
    chat_id: &str,
    read: ReadBatch,
) -> Result<bool, GatewayApplicationError> {
    for record in read.records {
        if !super::changes_projection(&record.event) {
            continue;
        }
        let checkpoint = read.checkpoint.at(record.end, record.anchor);
        if !super::project_event(context, chat_id, record.event, checkpoint).await? {
            return Ok(false);
        }
    }
    super::save_checkpoint(context, read.checkpoint).await?;
    Ok(true)
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
        Err(_) => return Err(GatewayApplicationError::internal()),
    };
    if !metadata.is_file() {
        return Ok(None);
    }
    // Hosts without file ids record 0/0; the checkpoint then rests on the
    // path, size and boundary anchor alone, as before.
    let (device, inode) = butler_platform::secure_fs::identity(&metadata)
        .id
        .map_or((0, 0), |id| (id.device, id.inode));
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
