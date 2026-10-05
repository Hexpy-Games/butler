//! Source save_hot summarization and no-generation global/topic cache write.

mod compact;

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime},
};

use chrono::{DateTime, Local, Utc};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use butler_core::public_text::trim_js_whitespace;
use butler_memory::cognition::{CognitionPathEnvironment, ensure_data_authority};
use butler_memory::coordination::{
    CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator,
};
use butler_models::models::{
    ModelProvider, ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest,
};

pub(super) struct LegacyHot {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    provider: Arc<ModelProvider>,
}

impl LegacyHot {
    pub(super) fn new(
        data_root: PathBuf,
        paths: CognitionPathEnvironment,
        coordinator: Arc<CognitionWriteCoordinator>,
        provider: Arc<ModelProvider>,
    ) -> Self {
        Self {
            data_root,
            paths,
            coordinator,
            provider,
        }
    }

    pub(super) async fn save(
        &self,
        conversation: &str,
        project: &str,
        session_id: &str,
        topic: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<String, crate::host::HostError> {
        let text = butler_memory::cognition::legacy_hot_prefix(conversation);
        let text = trim_js_whitespace(&text);
        if text.is_empty() {
            return Ok(String::new());
        }
        let body = if text.starts_with("**") {
            text.to_owned()
        } else {
            let prompt = format!(
                "Analyze the following conversation and summarize it in the format below. Omit any sections that don't apply.\n\n**Task**: Work performed, decisions made, completed/incomplete items (dev/file/search etc.)\n**Learning**: New concepts learned, important insights\n**Chat**: Core of casual conversation, exchange of opinions\n**Preference**: User preferences/tastes/tendencies newly revealed in this conversation (exclude recurring ones)\n\nEach section in 1-2 lines max. Omit the section entirely if empty.\n\nConversation:\n{text}"
            );
            let root = self.data_root.to_string_lossy().into_owned();
            let summary = self.provider.run_prompt(
                ProviderPromptRequest {
                    prompt: &prompt,
                    model: None,
                    reasoning_effort: None,
                    instructions: None,
                    response_format: None,
                    cache_scope: None,
                    cache_boundary: None,
                    cancellation: cancellation.clone(),
                    attachments: &[],
                    butler_data: Some(&root),
                    usage_attribution: None,
                    stream_observer: None,
                    provider_retry_attempts: None,
                },
                ProviderPromptLifecycle::none(),
            );
            tokio::time::timeout(Duration::from_secs(120), summary)
                .await
                .map_err(|source| {
                    crate::host::HostError::new("legacy_hot_summary_timeout").with_source(source)
                })?
                .map_err(|source| {
                    crate::host::HostError::new("legacy_hot_summary_failed").with_source(source)
                })?
                .text
        };
        if trim_js_whitespace(&body).is_empty() {
            return Err("hot_cache_entry_empty".into());
        }
        if contains_secret(&body) {
            return Err("hot_cache_secret_rejected".into());
        }
        if cancellation.is_cancelled() {
            return Err("memory_write_aborted".into());
        }
        let memory = self.paths.memory_root(&self.data_root);
        let lock = self.paths.consolidation_lock(&self.data_root);
        let target = match topic {
            Some(value) if !trim_js_whitespace(value).is_empty() => {
                let slug = trim_js_whitespace(value).replace(['/', '\\', '\0'], "_");
                memory.join("hot/topics").join(format!("{slug}.md"))
            }
            _ => memory.join("hot/cache.md"),
        };
        let temp = target.with_extension(format!("md.tmp-{}", uuid::Uuid::new_v4()));
        let data = self.data_root.clone();
        ensure_data_authority(
            &data,
            &[
                &self.paths.cognition_root(&data),
                &memory,
                &lock,
                &target,
                &temp,
                &target.with_extension("md.lock"),
            ],
        )
        .map_err(|failure| failure.code().to_owned())?;
        let lease = self
            .coordinator
            .acquire(
                CognitionWriteAcquire::immediate(lock, "legacy-hot-cache"),
                CognitionWaitClass::Background,
            )
            .await
            .map_err(|failure| failure.code().to_owned())?
            .ok_or_else(|| "memory_write_busy".to_owned())?;
        let project = project.to_owned();
        let session_id = session_id.to_owned();
        let topic = topic.map(str::to_owned);
        let time = DateTime::<Local>::from(SystemTime::now())
            .format("%H:%M")
            .to_string();
        let entry = format!(
            "\n## [{time}] {project} | {session_id}{}\n{body}\n",
            topic
                .as_deref()
                .map_or(String::new(), |value| format!(" | topic={value}"))
        );
        tokio::task::spawn_blocking(move || {
            let result = commit(&HotCommit {
                data: &data,
                target: &target,
                temp: &temp,
                body: &body,
                project: &project,
                session_id: &session_id,
                topic: topic.as_deref(),
                entry: &entry,
            });
            let release = lease.release(result.is_ok()).map_err(|failure| {
                crate::host::HostError::new(failure.code()).with_source(failure)
            });
            match (result, release) {
                (Err(code), _) | (Ok(()), Err(code)) => Err(code),
                _ => Ok(entry),
            }
        })
        .await
        .map_err(|source| {
            crate::host::HostError::new("legacy_hot_write_failed").with_source(source)
        })?
    }
}

struct HotCommit<'a> {
    data: &'a Path,
    target: &'a Path,
    temp: &'a Path,
    body: &'a str,
    project: &'a str,
    session_id: &'a str,
    topic: Option<&'a str>,
    entry: &'a str,
}

fn commit(input: &HotCommit<'_>) -> Result<(), crate::host::HostError> {
    let HotCommit {
        data,
        target,
        temp,
        body,
        project,
        session_id,
        topic,
        entry,
    } = *input;
    let parent = target.parent().ok_or("legacy_hot_write_failed")?;
    fs::create_dir_all(parent).map_err(|source| {
        crate::host::HostError::new("legacy_hot_write_failed").with_source(source)
    })?;
    ensure_data_authority(data, &[target, temp]).map_err(|failure| failure.code().to_owned())?;
    let lock_path = target.with_extension("md.lock");
    ensure_data_authority(data, &[&lock_path]).map_err(|failure| failure.code().to_owned())?;
    let _lock = acquire_lock(&lock_path)?;
    let now: DateTime<Utc> = SystemTime::now().into();
    if topic.is_some() {
        return append_topic(target, entry);
    }
    let Some(output) = global_output(target, project, session_id, body, now)? else {
        return Ok(());
    };
    let result: Result<(), crate::host::HostError> = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        let _ = butler_platform::secure_fs::owner_only(&mut options);
        let mut file = options.open(temp).map_err(|source| {
            crate::host::HostError::new("legacy_hot_write_failed").with_source(source)
        })?;
        file.write_all(output.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|source| {
                crate::host::HostError::new("legacy_hot_write_failed").with_source(source)
            })?;
        drop(file);
        butler_platform::secure_fs::rename(temp, target)
            .and_then(|()| butler_platform::secure_fs::sync_directory(parent).unwrap_or(Ok(())))
            .map_err(|source| {
                crate::host::HostError::new("legacy_hot_write_failed").with_source(source)
            })
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

fn append_topic(target: &Path, entry: &str) -> Result<(), crate::host::HostError> {
    let append = || -> std::io::Result<()> {
        let existed = target.try_exists()?;
        let mut file = butler_platform::secure_fs::append_private(target)?;
        file.write_all(entry.as_bytes())?;
        file.sync_all()?;
        if !existed && let Some(parent) = target.parent() {
            butler_platform::secure_fs::sync_directory(parent).unwrap_or(Ok(()))?;
        }
        Ok(())
    };
    append().map_err(|source| {
        crate::host::HostError::new("legacy_hot_write_failed").with_source(source)
    })
}

fn global_output(
    target: &Path,
    project: &str,
    session_id: &str,
    body: &str,
    now: DateTime<Utc>,
) -> Result<Option<String>, crate::host::HostError> {
    let source_id = {
        let digest = Sha256::digest(format!("{project}\0{session_id}\0{body}").as_bytes());
        let mut hex = format!("{digest:x}");
        hex.truncate(32);
        format!("save_{hex}")
    };
    let start = format!("<!-- butler-semantic:{source_id}:start -->");
    let current = match fs::read_to_string(target) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return Err("legacy_hot_write_failed".into()),
    };
    if current.contains(&start) {
        return Ok(None);
    }
    if body.encode_utf16().count() > 8000 {
        return Err("hot_cache_entry_too_large".into());
    }
    let block = format!(
        "{start}\n## [{}] global | {session_id}\n- source_id: {source_id}\n- scope: global\n\n{body}\n<!-- butler-semantic:{source_id}:end -->",
        now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    );
    let appended = format!(
        "{}{}{}\n",
        current.trim_end(),
        if current.trim().is_empty() {
            ""
        } else {
            "\n\n"
        },
        block
    );
    Ok(Some(compact::compact(&appended, 20 * 1024)))
}

struct CacheLock(PathBuf);

impl Drop for CacheLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn acquire_lock(path: &Path) -> Result<CacheLock, crate::host::HostError> {
    if try_create_lock(path).is_ok() {
        return Ok(CacheLock(path.to_path_buf()));
    }
    let stale = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age.as_secs() > 600);
    if stale {
        let _ = fs::remove_file(path);
        if try_create_lock(path).is_ok() {
            return Ok(CacheLock(path.to_path_buf()));
        }
    }
    Err("hot_cache_destination_locked".into())
}

fn try_create_lock(path: &Path) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    let _ = butler_platform::secure_fs::owner_only(&mut options);
    let mut file = options.open(path)?;
    if let Err(error) = writeln!(file, "{}", std::process::id()) {
        let _ = fs::remove_file(path);
        return Err(error);
    }
    Ok(())
}

fn contains_secret(value: &str) -> bool {
    // Only the last alternative is case-insensitive.
    static SECRET: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        butler_core::public_text::fixed_regex(
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b|\bAKIA[0-9A-Z]{16}\b|(?i:\b(?:password|passwd|token|api[_ -]?key)\s*[:=]\s*[^\s]{8,})",
        )
    });
    SECRET.is_match(value)
}
