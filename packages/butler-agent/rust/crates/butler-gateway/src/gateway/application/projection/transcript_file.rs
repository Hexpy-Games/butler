//! Transcript file identity, bounded byte-window reads, and checkpoint reuse.

use std::{path::PathBuf, time::UNIX_EPOCH};

use sha2::{Digest, Sha256};

use super::{ProjectionContext, checkpoint::Checkpoint};
use crate::gateway::application::{GatewayApplicationError, app_error};

pub(in crate::gateway::application) async fn sync_chat_once(
    context: &ProjectionContext,
    chat_id: &str,
) -> Result<bool, GatewayApplicationError> {
    let chat = chat_id.to_owned();
    let session_id = context
        .storage
        .read(move |db| super::super::sessions::identity::runtime_hint(db, &chat))
        .await
        .map_err(app_error)?;
    let path = context
        .butler_data
        .join("transcripts")
        .join(transcript_name(&session_id));
    let prior = previous_checkpoint(context, chat_id).await?;
    let path_for_read = path.clone();
    let state = tokio::task::spawn_blocking(move || file_state(&path_for_read))
        .await
        .map_err(GatewayApplicationError::internal_from)??;
    let Some(state) = state else { return Ok(false) };
    let spool_path = spool_path(&context.butler_data, chat_id, &path);
    let reusable = prior
        .as_ref()
        .is_some_and(|value| super::byte_window::reusable(value, &path, state.size));
    if reusable
        && prior
            .as_ref()
            .is_some_and(|value| is_complete(value, &state))
    {
        return Ok(false);
    }
    let mut checkpoint = match prior.clone() {
        Some(value) if reusable => value,
        found => {
            if found.is_some() {
                butler_core::diagnostic!(
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
        super::byte_window::read_record(checkpoint, state.size, state.modified_at_ms)
    })
    .await
    .map_err(GatewayApplicationError::internal_from)?
    .map_err(app_error)?;
    if read.checkpoint.spool_bytes == 0 {
        read.checkpoint.spool_path.clear();
    }
    let pending = read.pending;
    let completed = read.completed_spool.clone();
    let advanced = match read.event {
        // A sweep over a chat whose file has not changed writes nothing.
        None if prior.as_ref() == Some(&read.checkpoint) => true,
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

fn transcript_name(session_id: &str) -> String {
    format!(
        "{}.jsonl",
        session_id.replace(
            |ch: char| !ch.is_ascii_alphanumeric() && !"._-".contains(ch),
            "_"
        )
    )
}

// An unchanged, completed transcript must not rewrite its checkpoint on a
// later sweep. A changed file identity still updates the durable checkpoint.
fn is_complete(checkpoint: &Checkpoint, state: &FileState) -> bool {
    checkpoint.projected_bytes == state.size
        && checkpoint.trailing.is_empty()
        && checkpoint.spool_bytes == 0
        && checkpoint.device == state.device
        && checkpoint.inode == state.inode
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

async fn previous_checkpoint(
    context: &ProjectionContext,
    chat_id: &str,
) -> Result<Option<Checkpoint>, GatewayApplicationError> {
    if let Some(cursor) = context.streaming.checkpoint(chat_id) {
        return Ok(Some(cursor));
    }
    let chat = chat_id.to_owned();
    context
        .storage
        .inspect(move |db| super::checkpoint::load(db, &chat))
        .await
        .map_err(app_error)
}
