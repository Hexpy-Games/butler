//! Source no-generation transcript sync over live SessionBinding and model owners.

mod hot;

use std::{future::Future, path::PathBuf, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

use butler_memory::cognition::{
    CognitionEmbeddingPort, CognitionError, CognitionPathEnvironment, CognitionResult,
    LegacyIndexService, LegacySessionOffsets, append_legacy_session_diagnostic,
    ensure_data_authority, index_legacy_transcript_query, normalize_session_id_for_storage,
    prepare_legacy_transcript, read_legacy_new_lines,
};
use butler_memory::coordination::CognitionWriteCoordinator;
use butler_models::models::ModelProvider;
use butler_turn::workspace::{
    SessionBindingStore, SessionLifecycleState, SessionRole, StoredSessionBinding,
};

use crate::host::EmbeddingOwner;
use butler_memory::cognition::CognitionCode;

pub(in crate::host) struct LegacySessionSync {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    bindings: SessionBindingStore,
    index: LegacyIndexService,
    hot: hot::LegacyHot,
    embedding: Arc<EmbeddingOwner>,
}

impl LegacySessionSync {
    pub(in crate::host) fn new(
        data_root: PathBuf,
        paths: CognitionPathEnvironment,
        coordinator: Arc<CognitionWriteCoordinator>,
        bindings: SessionBindingStore,
        provider: Arc<ModelProvider>,
        embedding: Arc<EmbeddingOwner>,
    ) -> Self {
        Self {
            index: LegacyIndexService::new(
                data_root.clone(),
                paths.clone(),
                coordinator.clone(),
                embedding.clone(),
            ),
            embedding,
            hot: hot::LegacyHot::new(data_root.clone(), paths.clone(), coordinator, provider),
            data_root,
            paths,
            bindings,
        }
    }

    pub(in crate::host) async fn run(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<(), crate::host::HostError> {
        let data_root = self.data_root.clone();
        let memory_root = self.paths.memory_root(&data_root);
        let transcript_root = data_root.join(butler_platform::data_paths::TRANSCRIPTS);
        ensure_data_authority(
            &data_root,
            &[
                &self.paths.cognition_root(&data_root),
                &memory_root,
                &memory_root.join("db/session-sync-offset.json"),
                &transcript_root,
            ],
        )
        .map_err(|failure| failure.code().to_owned())?;
        let mut offsets = tokio::task::spawn_blocking({
            let root = data_root.clone();
            let memory = memory_root.clone();
            move || {
                std::fs::create_dir_all(memory.join("db")).map_err(|source| {
                    butler_memory::cognition::CognitionError::new(
                        CognitionCode::LegacySessionOffsetWriteFailed,
                        "legacy_session_offset_write_failed",
                    )
                    .with_source(source)
                })?;
                LegacySessionOffsets::load(&root, &memory)
            }
        })
        .await
        .map_err(|source| {
            crate::host::HostError::new("legacy_session_offset_read_failed").with_source(source)
        })?
        .map_err(|failure| failure.code().to_owned())?;
        let mut sessions = self
            .bindings
            .list_sessions(Some(vec![
                SessionLifecycleState::Active,
                SessionLifecycleState::Closing,
            ]))
            .await
            .map_err(|source| {
                crate::host::HostError::new("legacy_session_store_unavailable").with_source(source)
            })?;
        sessions.sort_by(compare_sessions);
        let mut visited = 0usize;
        for session in sessions {
            if cancellation.is_cancelled() {
                return Err("memory_write_aborted".into());
            }
            let path = transcript_root.join(format!(
                "{}.jsonl",
                normalize_session_id_for_storage(&session.session_id)
            ));
            ensure_data_authority(&data_root, &[&path])
                .map_err(|failure| failure.code().to_owned())?;
            if !path.exists() {
                continue;
            }
            let project = session.project_id.clone().unwrap_or_else(|| {
                if session.role == SessionRole::Butler {
                    "butler".into()
                } else {
                    session.session_id.clone()
                }
            });
            let key = format!("{project}:{}", session.session_id);
            let prior = offsets.get(&key).cloned();
            let (lines, next) = tokio::task::spawn_blocking({
                let root = data_root.clone();
                let path = path.clone();
                let session_id = session.session_id.clone();
                move || read_legacy_new_lines(&root, &path, &session_id, prior.as_ref())
            })
            .await
            .map_err(|source| {
                crate::host::HostError::new("legacy_transcript_read_failed").with_source(source)
            })?
            .map_err(|failure| failure.code().to_owned())?;
            if !lines.is_empty() {
                let line_count = lines.len();
                let (message_count, chunks) =
                    prepare_legacy_transcript(&lines, &session.session_id);
                let query = tokio::task::spawn_blocking({
                    let root = data_root.clone();
                    let path = path.clone();
                    move || index_legacy_transcript_query(&root, &path, &lines)
                })
                .await
                .map_err(|source| {
                    crate::host::HostError::new("legacy_query_index_failed").with_source(source)
                })?;
                query.map_err(|failure| failure.code().to_owned())?;
                if message_count == 0 {
                    let root = data_root.clone();
                    let memory = memory_root.clone();
                    let session_id = session.session_id.clone();
                    let project = project.clone();
                    tokio::task::spawn_blocking(move || {
                        append_legacy_session_diagnostic(
                            &root,
                            &memory,
                            &session_id,
                            &project,
                            line_count,
                        )
                    })
                    .await
                    .map_err(|source| {
                        crate::host::HostError::new("legacy_diagnostic_failed").with_source(source)
                    })?
                    .map_err(|failure| failure.code().to_owned())?;
                }
                // With the memory model off there is no legacy vector index to
                // feed; the summaries are kept and the offsets still advance, so
                // a chunk is never summarized twice.
                let vectors = self.embedding.enabled();
                for chunk in chunks {
                    if cancellation.is_cancelled() {
                        return Err("memory_write_aborted".into());
                    }
                    if butler_core::public_text::trim_js_whitespace(&chunk.conversation_text)
                        .is_empty()
                    {
                        continue;
                    }
                    let chunk = ChunkTexts {
                        conversation: &chunk.conversation_text,
                        index: &chunk.index_text,
                        storage_id: &chunk.storage_id,
                        original_id: &chunk.original_id,
                    };
                    self.sync_chunk(chunk, &project, &session, vectors, cancellation)
                        .await?;
                }
            }
            offsets.insert(key, next);
            visited += 1;
        }
        if visited > 0 {
            tokio::task::spawn_blocking(move || offsets.save(&data_root, &memory_root))
                .await
                .map_err(|source| {
                    crate::host::HostError::new("legacy_session_offset_write_failed")
                        .with_source(source)
                })?
                .map_err(|failure| failure.code().to_owned())?;
        }
        butler_core::diagnostic!("[session-sync] legacySessions={visited}");
        Ok(())
    }
    /// Saves one chunk's hot summary and, with the memory model on, indexes
    /// the summary and the chunk for legacy vector search.
    async fn sync_chunk(
        &self,
        chunk: ChunkTexts<'_>,
        project: &str,
        session: &StoredSessionBinding,
        vectors: bool,
        cancellation: &CancellationToken,
    ) -> Result<(), crate::host::HostError> {
        let topic = session
            .transport_bindings
            .iter()
            .find_map(|binding| binding.thread_id.as_deref());
        match self
            .hot
            .save(
                chunk.conversation,
                project,
                chunk.storage_id,
                topic,
                summary_usage(session),
                cancellation,
            )
            .await
        {
            Ok(entry) if vectors && !entry.is_empty() => {
                let hot_id = normalize_session_id_for_storage(&format!("hot_{}", chunk.storage_id));
                let admission = cancellation.child_token();
                if let Err(failure) = await_index(
                    self.index.index_hot_entry(
                        &entry,
                        &hot_id,
                        chunk.storage_id,
                        project,
                        topic,
                        &admission,
                    ),
                    &admission,
                )
                .await
                {
                    log_hot_failure("index", failure.code());
                }
            }
            Err(code) => log_hot_failure("save", code.message()),
            _ => {}
        }
        if !vectors {
            return Ok(());
        }
        let admission = cancellation.child_token();
        await_index(
            self.index.index_transcript(
                chunk.index,
                chunk.storage_id,
                chunk.original_id,
                project,
                &admission,
            ),
            &admission,
        )
        .await
        .map_err(|failure| failure.code().to_owned())?;
        Ok(())
    }
}

/// The texts and ids of one transcript chunk.
struct ChunkTexts<'a> {
    conversation: &'a str,
    index: &'a str,
    storage_id: &'a str,
    original_id: &'a str,
}

/// A root session owns its summary's usage; a delegated child bills its
/// recorded root under its own role, or stays in the named non-chat scope.
fn summary_usage(session: &StoredSessionBinding) -> hot::SummaryUsage<'_> {
    let subsession = session
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("subsession"));
    let root = match subsession {
        None => Some(session.session_id.as_str()),
        Some(subsession) => subsession
            .get("root_session_id")
            .and_then(serde_json::Value::as_str),
    };
    let role = match &session.role {
        SessionRole::Butler => "main",
        SessionRole::Steward => "steward",
        SessionRole::Worker => "worker",
        SessionRole::Unknown(role) => role,
    };
    hot::SummaryUsage { root, role }
}

fn compare_sessions(
    left: &StoredSessionBinding,
    right: &StoredSessionBinding,
) -> std::cmp::Ordering {
    left.updated_at
        .cmp(&right.updated_at)
        .then_with(|| left.session_id.cmp(&right.session_id))
}

async fn await_index<F>(future: F, cancellation: &CancellationToken) -> CognitionResult<()>
where
    F: Future<Output = CognitionResult<()>>,
{
    tokio::pin!(future);
    tokio::select! {
        result = &mut future => result,
        () = tokio::time::sleep(Duration::from_secs(120)) => {
            cancellation.cancel();
            // A Lance mutation already admitted must finish while its write lease remains held.
            let _ = future.await;
            Err(CognitionError::new(CognitionCode::LegacySessionIndexTimeout, "legacy_session_index_timeout"))
        }
    }
}

fn log_hot_failure(operation: &str, code: &str) {
    butler_core::diagnostic!("[session-sync] hot {operation} failed: {code}");
}
