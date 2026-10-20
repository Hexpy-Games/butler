//! Durable message-store ownership begins before a transcript can name a copy.
use super::*;

pub(super) fn promote(
    data: &Path,
    turn: &str,
    parent_turn: Option<&str>,
    source: &Path,
) -> io::Result<PathBuf> {
    let relative = source
        .strip_prefix(data.join(crate::data_paths::READER_STAGING))
        .map_err(|_| io::Error::other("invalid_staging_path"))?;
    if relative.components().count() != 2 {
        return Err(io::Error::other("invalid_staging_path"));
    }
    let root = data.join(crate::data_paths::MESSAGE_HANDOFFS);
    let key = format!("{:x}", Sha256::digest(turn.as_bytes()));
    let directory = root.join(key);
    super::super::create_private_dir_all(&root)?;
    if !directory.exists() {
        let temporary = super::super::unique_temporary(&root.join("handoff"));
        super::super::create_private_dir(&temporary)?;
        let result = (|| {
            super::super::hold_point("message_handoff_owner", || false)?;
            adopt(&temporary.join("copy"), turn, parent_turn)?;
            super::super::sync_directory(&temporary).unwrap_or(Ok(()))?;
            super::super::rename(&temporary, &directory)
        })();
        if result.is_err() {
            let _ = super::super::remove_tree(&temporary);
        }
        result?;
    }
    let destination = directory.join(
        relative
            .components()
            .next()
            .ok_or_else(|| io::Error::other("invalid_staging_path"))?
            .as_os_str(),
    );
    if !source.exists() && destination.is_file() {
        return Ok(destination);
    }
    // Bound outstanding durable copies independently of transient reader copies.
    let mut size = 0u64;
    for (index, entry) in std::fs::read_dir(&root)?.enumerate() {
        if index >= 1024 {
            return Err(io::Error::other("handoff_limit_exceeded"));
        }
        for file in std::fs::read_dir(entry?.path())? {
            size = size.saturating_add(file?.metadata()?.len());
        }
    }
    if size.saturating_add(source.metadata()?.len()) > MAX_TOTAL {
        return Err(io::Error::other("handoff_limit_exceeded"));
    }
    adopt(&destination, turn, parent_turn)?;
    super::super::rename(source, &destination)?;
    super::super::sync_directory(&directory).unwrap_or(Ok(()))?;
    super::super::sync_directory(&root).unwrap_or(Ok(()))?;
    if let Some(parent) = source.parent() {
        let _ = std::fs::remove_dir(parent);
    }
    Ok(destination)
}

/// Parent closeout takes ownership of selected worker files before publication.
pub(super) fn adopt(path: &Path, turn: &str, parent_turn: Option<&str>) -> io::Result<()> {
    let directory = path
        .parent()
        .ok_or_else(|| io::Error::other("invalid_handoff"))?;
    let identity = serde_json::to_vec(&serde_json::json!({"turn":turn,"parent_turn":parent_turn}))
        .map_err(io::Error::other)?;
    super::super::replace_private(
        &directory.join(".turn"),
        |file| {
            use std::io::Write;
            file.write_all(&identity)
        },
        std::convert::identity,
    )
}

/// Recover interrupted publication before admitting producers under the instance lock.
pub(super) fn recover(data: &Path) -> io::Result<()> {
    let root = data.join(crate::data_paths::MESSAGE_HANDOFFS);
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_dir()
            && (entry.file_name().to_string_lossy().starts_with(".handoff.")
                || !entry.path().join(".turn").is_file())
        {
            super::super::remove_tree(&entry.path())?;
        }
    }
    Ok(())
}
