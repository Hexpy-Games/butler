use std::{fs, io, path::Path};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(super) struct Files {
    pub bytes: Option<u64>,
    pub markdown: u64,
    pub latest: Option<String>,
}

pub(super) fn files(path: &Path, token: &CancellationToken) -> io::Result<Files> {
    let mut result = Files {
        bytes: Some(0),
        ..Files::default()
    };
    walk(path, token, &mut result)?;
    Ok(result)
}

fn walk(path: &Path, token: &CancellationToken, result: &mut Files) -> io::Result<()> {
    super::safety::cancelled(token)?;
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if metadata.file_type().is_symlink() {
        return Err(io::Error::other("Linked storage cannot be measured"));
    }
    result.bytes = result
        .bytes
        .zip(butler_platform::storage_size::allocated_bytes(path)?)
        .map(|(sum, bytes)| sum.saturating_add(bytes));
    if metadata.is_dir() {
        for entry in fs::read_dir(path)? {
            walk(&entry?.path(), token, result)?;
        }
    } else {
        if path.extension().is_some_and(|e| e == "md")
            && path.file_name().is_none_or(|n| n != "INDEX.md")
        {
            result.markdown += 1;
        }
        let time = metadata
            .modified()
            .ok()
            .map(butler_core::js_date::iso_from_system_time);
        if path.extension().is_some_and(|e| e == "md")
            && path.file_name().is_none_or(|n| n != "INDEX.md")
        {
            result.latest = result.latest.take().max(time);
        }
    }
    Ok(())
}
