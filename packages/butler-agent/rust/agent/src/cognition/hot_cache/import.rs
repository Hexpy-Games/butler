//! Named owner operations used by the source memory-ingest command.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime},
};

use chrono::{DateTime, Local, Utc};
use sha2::{Digest, Sha256};

use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult,
        mutable_paths::ensure_data_authority,
    },
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
    public_text::{trim_js_whitespace, trim_js_whitespace_end},
};

use super::{LegacyIndexService, legacy_graph};

const HOT_CACHE_LOCK_STALE_AFTER: Duration = Duration::from_secs(10 * 60);

impl LegacyIndexService {
    pub(crate) async fn write_legacy_import_summary(
        data_root: &Path,
        paths: &CognitionPathEnvironment,
        coordinator: Arc<CognitionWriteCoordinator>,
        summary: &str,
        project: &str,
        chunk_id: &str,
    ) -> CognitionResult<String> {
        let body = trim_js_whitespace(summary).to_owned();
        if body.is_empty() {
            return Err(error("hot_cache_entry_empty"));
        }
        if body.encode_utf16().count() > 8_000 {
            return Err(error("hot_cache_entry_too_large"));
        }
        if super::super::continuity_recovery::hot_cache::compact::contains_secret(&body) {
            return Err(error("hot_cache_secret_rejected"));
        }
        let data_root = data_root.to_owned();
        let memory_root = paths.memory_root(&data_root);
        let cache = memory_root.join("hot/cache.md");
        let destination_lock = cache.with_extension("md.lock");
        let coordination_lock = paths.consolidation_lock(&data_root);
        let source_id = format!(
            "save_{}",
            &format!(
                "{:x}",
                Sha256::digest(format!("{project}\0{chunk_id}\0{body}").as_bytes())
            )[..32]
        );
        let created_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let marker = format!("<!-- butler-semantic:{source_id}:start -->");
        let block = format!(
            "{marker}\n## [{created_at}] global | {chunk_id}\n- source_id: {source_id}\n- scope: global\n\n{body}\n<!-- butler-semantic:{source_id}:end -->"
        );
        let entry_time = DateTime::<Local>::from(SystemTime::now())
            .format("%H:%M")
            .to_string();
        let index_text = format!("\n## [{entry_time}] {project} | {chunk_id}\n{body}\n");
        let temp = cache.with_file_name(format!(
            ".{}.{}.tmp",
            cache
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("cache.md"),
            uuid::Uuid::new_v4()
        ));
        let audit = cache.with_file_name("cache.md.audit.md");
        ensure_data_authority(
            &data_root,
            &[
                &paths.cognition_root(&data_root),
                &memory_root,
                &coordination_lock,
                &cache,
                &destination_lock,
                &temp,
                &audit,
            ],
        )?;
        let lease = coordinator
            .acquire(
                CognitionWriteAcquire::immediate(
                    coordination_lock.clone(),
                    "legacy-memory-import-hot-cache",
                ),
                CognitionWaitClass::Interactive,
            )
            .await
            .map_err(|failure| CognitionError::new(failure.code, failure.message))?
            .ok_or_else(|| error("memory_write_busy"))?;
        let result = tokio::task::spawn_blocking(move || {
            let result = (|| {
                lease
                    .assert_for_path(&coordination_lock)
                    .map_err(|_| error("memory_write_busy"))?;
                write_cache_entry(
                    &data_root,
                    &cache,
                    &destination_lock,
                    &temp,
                    &audit,
                    &block,
                    &marker,
                )
            })();
            let released = lease
                .release(result.is_ok())
                .map_err(|failure| CognitionError::new(failure.code, failure.message));
            match (result, released) {
                (Err(failure), _) => Err(failure),
                (Ok(()), Err(failure)) => Err(failure),
                (Ok(()), Ok(())) => Ok(()),
            }
        })
        .await
        .map_err(|_| error("hot_cache_write_failed"))?;
        result?;
        Ok(index_text)
    }
}

pub(crate) fn extract_legacy_import_transcript(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    text: &str,
    chunk_id: &str,
    project: &str,
) -> CognitionResult<usize> {
    let memory_root = paths.memory_root(data_root);
    let timestamp = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| error("memory_graph_unavailable"))?
        .as_secs() as i64;
    legacy_graph::extract_and_save(
        data_root,
        &memory_root,
        text,
        chunk_id,
        project,
        None,
        timestamp,
    )
    .map_err(|code| CognitionError::new("memory_graph_unavailable", code))
}

fn write_cache_entry(
    data_root: &Path,
    cache: &Path,
    lock_path: &Path,
    temp: &Path,
    audit: &Path,
    block: &str,
    marker: &str,
) -> CognitionResult<()> {
    let parent = cache
        .parent()
        .ok_or_else(|| error("hot_cache_write_failed"))?;
    fs::create_dir_all(parent).map_err(|_| error("hot_cache_write_failed"))?;
    ensure_data_authority(data_root, &[parent, cache, lock_path, temp, audit])?;
    let _lock = acquire_cache_lock(lock_path)?;
    let current = match fs::read(cache) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return Err(error("hot_cache_write_failed")),
    };
    if current.contains(marker) {
        return Ok(());
    }
    let trimmed = trim_js_whitespace_end(&current);
    let appended = if trimmed.is_empty() {
        format!("{block}\n")
    } else {
        format!("{trimmed}\n\n{block}\n")
    };
    let bounded =
        super::super::continuity_recovery::hot_cache::compact::compact_hot_cache(&appended);
    if !bounded.audit.is_empty() {
        preserve_audit(data_root, audit, &bounded.audit)?;
    }
    write_atomic(data_root, cache, temp, &bounded.body)
}

fn preserve_audit(data_root: &Path, path: &Path, body: &str) -> CognitionResult<()> {
    let current = match fs::read(path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return Err(error("hot_cache_write_failed")),
    };
    if current.contains(body.trim()) {
        return Ok(());
    }
    let next = format!(
        "{}{}{}",
        trim_js_whitespace_end(&current),
        if trim_js_whitespace(&current).is_empty() {
            ""
        } else {
            "\n\n"
        },
        body
    );
    let temp = path.with_file_name(format!(".audit.{}.tmp", uuid::Uuid::new_v4()));
    write_atomic(data_root, path, &temp, &next)
}

fn write_atomic(data_root: &Path, path: &Path, temp: &Path, body: &str) -> CognitionResult<()> {
    ensure_data_authority(data_root, &[path, temp])?;
    let mut created_temp = false;
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(temp)
            .map_err(|_| error("hot_cache_write_failed"))?;
        created_temp = true;
        file.write_all(body.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|_| error("hot_cache_write_failed"))?;
        fs::rename(temp, path).map_err(|_| error("hot_cache_write_failed"))
    })();
    if created_temp {
        let _ = fs::remove_file(temp);
    }
    result
}

struct CacheLock(PathBuf);

impl Drop for CacheLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn acquire_cache_lock(path: &Path) -> CognitionResult<CacheLock> {
    match create_private_lock(path) {
        Ok(()) => Ok(CacheLock(path.to_owned())),
        Err(failure) if failure.kind() == std::io::ErrorKind::AlreadyExists => {
            let stale = fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                .is_some_and(|age| age > HOT_CACHE_LOCK_STALE_AFTER);
            if stale {
                fs::remove_file(path).map_err(|_| error("hot_cache_destination_locked"))?;
                create_private_lock(path).map_err(|_| error("hot_cache_destination_locked"))?;
                return Ok(CacheLock(path.to_owned()));
            }
            Err(error("hot_cache_destination_locked"))
        }
        Err(_) => Err(error("hot_cache_destination_locked")),
    }
}

fn create_private_lock(path: &Path) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    writeln!(file, "{}", std::process::id())
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
