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
                .try_fold(0, |sum, p| Ok::<_, io::Error>(sum + fs::metadata(p)?.len()))?;
            stores.push(StoreUsage {
                id: format!("{source}/{store}"),
                bytes,
                limit_bytes: limit,
                retention_h,
                oldest_ts: entries.first().and_then(|p| timestamp(p)),
            });
        }
    }
    Ok(StorageView { stores })
}
pub(crate) fn prune(root: &Path) -> io::Result<()> {
    let now = chrono::Utc::now();
    for (store, limit, hours) in STORES {
        let entries = files(&root.join(store))?;
        let mut bytes = entries
            .iter()
            .try_fold(0, |sum, p| Ok::<_, io::Error>(sum + fs::metadata(p)?.len()))?;
        for path in entries {
            if !matches!(
                path.extension().and_then(|s| s.to_str()),
                Some("jsonl" | "zst")
            ) {
                continue;
            }
            let old = timestamp(&path)
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
                .is_some_and(|date| now.signed_duration_since(date).num_hours() >= hours);
            if old || bytes > limit {
                bytes = bytes.saturating_sub(fs::metadata(&path)?.len());
                fs::remove_file(&path)?;
                let index = path.with_extension("idx");
                if index.exists() {
                    bytes = bytes.saturating_sub(fs::metadata(&index)?.len());
                    fs::remove_file(index)?;
                }
            }
        }
    }
    Ok(())
}
pub(crate) fn remove(dir: &Path) -> io::Result<u64> {
    let bytes = files(dir)?
        .iter()
        .try_fold(0, |sum, p| Ok::<_, io::Error>(sum + fs::metadata(p)?.len()))?;
    if dir.exists() {
        fs::remove_dir_all(dir)?;
    }
    Ok(bytes)
}
