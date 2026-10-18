use serde::Serialize;
use std::{
    fs, io,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize)]
pub struct StoreUsage {
    pub id: String,
    pub bytes: u64,
    pub limit_bytes: u64,
    pub retention_h: i64,
    pub oldest_ts: Option<String>,
}
#[derive(Serialize)]
pub struct StorageView {
    pub stores: Vec<StoreUsage>,
    pub write_timeouts: usize,
    pub last_write_error: Option<String>,
}
pub(crate) const STORES: [(&str, u64, i64); 3] = [
    ("main", 64 * 1024 * 1024, 14 * 24),
    ("debug", 256 * 1024 * 1024, 72),
    ("bodies", 256 * 1024 * 1024, 24),
];
pub(crate) fn files(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    match fs::read_dir(dir) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry?;
                if entry.file_type()?.is_file() {
                    files.push(entry.path());
                }
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    files.sort();
    Ok(files)
}
pub(crate) fn timestamp(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let prefix = name.get(..16)?;
    chrono::NaiveDateTime::parse_from_str(prefix, "%Y%m%dT%H%M%SZ")
        .ok()
        .map(|date| {
            date.and_utc()
                .to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
        })
}
pub(crate) fn usage(root: &Path) -> io::Result<StorageView> {
    let mut stores = Vec::new();
    for source in ["agent", "app"] {
        for (store, limit, retention_h) in STORES {
            let entries = files(&root.join(source).join(store))?;
            let bytes = entries
                .iter()
                .try_fold(0, |sum, p| Ok::<_, io::Error>(sum + size(p)?))?;
            stores.push(StoreUsage {
                id: format!("{source}/{store}"),
                bytes,
                limit_bytes: limit,
                retention_h,
                oldest_ts: entries.first().and_then(|p| timestamp(p)),
            });
        }
    }
    Ok(StorageView {
        stores,
        last_write_error: None,
        write_timeouts: 0,
    })
}
pub(crate) fn prune(root: &Path, active: &[PathBuf]) -> io::Result<()> {
    let now = chrono::Utc::now();
    for (store, limit, hours) in STORES {
        let entries = files(&root.join(store))?;
        let mut bytes = entries
            .iter()
            .try_fold(0, |sum, p| Ok::<_, io::Error>(sum + size(p)?))?;
        for path in entries {
            if !matches!(
                path.extension().and_then(|s| s.to_str()),
                Some("jsonl" | "zst")
            ) {
                continue;
            }
            if active.contains(&path) {
                continue;
            }
            let old = newest(&path)?
                .is_some_and(|date| now.signed_duration_since(date).num_hours() >= hours);
            if old || bytes > limit {
                bytes = bytes.saturating_sub(size(&path)?);
                remove_file(&path)?;
                let index = path.with_extension("idx");
                if index.exists() {
                    bytes = bytes.saturating_sub(size(&index)?);
                    remove_file(&index)?;
                }
            }
        }
    }
    Ok(())
}
pub(crate) fn remove(dir: &Path) -> io::Result<u64> {
    let bytes = files(dir)?
        .iter()
        .try_fold(0, |sum, p| Ok::<_, io::Error>(sum + size(p)?))?;
    if dir.exists() {
        ignore_removed(fs::remove_dir_all(dir))?;
    }
    Ok(bytes)
}

fn newest(path: &Path) -> io::Result<Option<chrono::DateTime<chrono::Utc>>> {
    match super::index::load(path) {
        Ok(blocks) => Ok(blocks
            .iter()
            .map(|b| &b.max_ts)
            .max()
            .and_then(|ts| chrono::DateTime::parse_from_rfc3339(ts).ok())
            .map(|ts| ts.with_timezone(&chrono::Utc))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => match fs::metadata(path) {
            Ok(metadata) => Ok(Some(metadata.modified()?.into())),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        },
        Err(e) => Err(e),
    }
}
fn size(path: &Path) -> io::Result<u64> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(0),
        Err(e) => Err(e),
    }
}
fn ignore_removed(result: io::Result<()>) -> io::Result<()> {
    match result {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}
fn remove_file(path: &Path) -> io::Result<()> {
    ignore_removed(fs::remove_file(path))
}
