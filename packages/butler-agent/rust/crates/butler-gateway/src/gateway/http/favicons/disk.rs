//! No startup scan, hit writes, negative entries or index. Eviction only accompanies insertion.
use super::{Icon, fetch::ICON_LIMIT};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

const EXTENSIONS: [&str; 5] = ["png", "ico", "gif", "jpg", "webp"];

fn key(host: &str) -> String {
    format!("{:x}", Sha256::digest(host.as_bytes()))
}

pub(super) fn load(root: &Path, host: &str) -> Option<Icon> {
    let key = key(host);
    for ext in EXTENSIONS {
        let path = root.join(format!("{key}.{ext}"));
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file()
            || meta.len() > ICON_LIMIT as u64
            || meta.modified().ok()?.elapsed().ok()? > Duration::from_hours(720)
        {
            continue;
        }
        let mut bytes = Vec::new();
        fs::File::open(path)
            .ok()?
            .take((ICON_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .ok()?;
        return Icon::new(bytes);
    }
    None
}

pub(super) fn store(root: &Path, host: &str, icon: &Icon) -> std::io::Result<()> {
    if load(root, host).is_some() {
        return Ok(());
    }
    fs::create_dir_all(root)?;
    let key = key(host);
    // Remove stale formats for this host; successful first fetch is the only writer.
    for ext in EXTENSIONS {
        let path = root.join(format!("{key}.{ext}"));
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    let mut entries = entries(root)?;
    entries.sort_by_key(|(_, _, modified)| *modified);
    let mut size: u64 = entries.iter().map(|(_, size, _)| size).sum();
    let mut count = entries.len();
    for (path, len, _) in entries {
        if count < 500 && size + icon.bytes.len() as u64 <= 5 * 1024 * 1024 {
            break;
        }
        fs::remove_file(path)?;
        size = size.saturating_sub(len);
        count -= 1;
    }
    let temporary = root.join(format!(".{key}-{}", uuid::Uuid::new_v4()));
    let destination = root.join(format!("{key}.{}", icon.ext));
    let result =
        fs::write(&temporary, &icon.bytes).and_then(|()| fs::rename(&temporary, destination));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn entries(root: &Path) -> std::io::Result<Vec<(PathBuf, u64, SystemTime)>> {
    Ok(fs::read_dir(root)?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let filename = path.file_name()?.to_str()?;
            let final_icon = path
                .file_stem()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.len() == 64
                        && name.bytes().all(|b| b.is_ascii_hexdigit())
                        && path
                            .extension()
                            .and_then(|ext| ext.to_str())
                            .is_some_and(|ext| EXTENSIONS.contains(&ext))
                });
            // A crash can leave an atomic-write temporary; it also counts toward the bounds.
            let orphan = filename
                .strip_prefix('.')
                .and_then(|name| name.split_once('-'))
                .is_some_and(|(key, id)| {
                    key.len() == 64
                        && key.bytes().all(|b| b.is_ascii_hexdigit())
                        && uuid::Uuid::parse_str(id).is_ok()
                });
            if !final_icon && !orphan {
                return None;
            }
            let meta = entry.metadata().ok()?;
            meta.is_file().then(|| {
                (
                    path,
                    meta.len(),
                    meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                )
            })
        })
        .collect::<Vec<_>>())
}
