//! Source no-generation transcript sync over live SessionBinding and model owners.

mod hot;

use std::{future::Future, path::PathBuf, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult, LegacyIndexService,
        LegacySessionOffsets, append_legacy_session_diagnostic, ensure_data_authority,
        index_legacy_transcript_query, normalize_session_id_for_storage, prepare_legacy_transcript,
        read_legacy_new_lines,
    },
    coordination::CognitionWriteCoordinator,
    models::NativeModelProvider,
    workspace::{SessionBindingStore, SessionLifecycleState, SessionRole},
};

use super::NativeEmbeddingOwner;

pub(super) struct NativeLegacySessionSync {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    bindings: SessionBindingStore,
    index: LegacyIndexService,
    hot: hot::NativeLegacyHot,
}

impl NativeLegacySessionSync {
    pub(super) fn new(
        data_root: PathBuf,
        paths: CognitionPathEnvironment,
        coordinator: Arc<CognitionWriteCoordinator>,
        bindings: SessionBindingStore,
        provider: Arc<NativeModelProvider>,
        embedding: Arc<NativeEmbeddingOwner>,
    ) -> Self {
        Self {
            index: LegacyIndexService::new(
                data_root.clone(),
                paths.clone(),
                coordinator.clone(),
                embedding,
            ),
            hot: hot::NativeLegacyHot::new(data_root.clone(), paths.clone(), coordinator, provider),
            data_root,
            paths,
            bindings,
        }
    }

    pub(super) async fn run(&self, cancellation: &CancellationToken) -> Result<(), String> {
        let data_root = self.data_root.clone();
        let memory_root = self.paths.memory_root(&data_root);
        let transcript_root = data_root.join("transcripts");
        ensure_data_authority(
            &data_root,
            &[
                &self.paths.cognition_root(&data_root),
                &memory_root,
                &memory_root.join("db/session-sync-offset.json"),
                &transcript_root,
            ],
        )
        .map_err(|failure| failure.code.to_owned())?;
        let mut offsets = tokio::task::spawn_blocking({
            let root = data_root.clone();
            let memory = memory_root.clone();
            move || {
                std::fs::create_dir_all(memory.join("db")).map_err(|_| {
                    crate::cognition::CognitionError::new(
                        "legacy_session_offset_write_failed",
                        "legacy_session_offset_write_failed",
                    )
                })?;
                LegacySessionOffsets::load(&root, &memory)
            }
        })
        .await
        .map_err(|_| "legacy_session_offset_read_failed".to_owned())?
        .map_err(|failure| failure.code.to_owned())?;
        let mut sessions = self
            .bindings
            .list_sessions(Some(vec![
                SessionLifecycleState::Active,
                SessionLifecycleState::Closing,
            ]))
            .await
            .map_err(|_| "legacy_session_store_unavailable".to_owned())?;
        sessions.sort_by(|a, b| a.updated_at.cmp(&b.updated_at));
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
                .map_err(|failure| failure.code.to_owned())?;
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
            let topic = session
                .transport_bindings
                .iter()
                .find_map(|binding| binding.thread_id.as_deref());
            let key = format!("{project}:{}", session.session_id);
            let prior = offsets.get(&key).cloned();
            let (lines, next) = tokio::task::spawn_blocking({
                let root = data_root.clone();
                let path = path.clone();
                let session_id = session.session_id.clone();
                move || read_legacy_new_lines(&root, &path, &session_id, prior.as_ref())
            })
            .await
            .map_err(|_| "legacy_transcript_read_failed".to_owned())?
            .map_err(|failure| failure.code.to_owned())?;
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
                .map_err(|_| "legacy_query_index_failed".to_owned())?;
                query.map_err(|failure| failure.code.to_owned())?;
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
                    .map_err(|_| "legacy_diagnostic_failed".to_owned())?
                    .map_err(|failure| failure.code.to_owned())?;
                }
                for chunk in chunks {
                    if cancellation.is_cancelled() {
                        return Err("memory_write_aborted".into());
                    }
                    if crate::public_text::trim_js_whitespace(&chunk.conversation_text).is_empty() {
                        continue;
                    }
                    match self
                        .hot
                        .save(
                            &chunk.conversation_text,
                            &project,
                            &chunk.storage_id,
                            topic,
                            cancellation,
                        )
                        .await
                    {
                        Ok(entry) if !entry.is_empty() => {
                            let hot_id = normalize_session_id_for_storage(&format!(
                                "hot_{}",
                                chunk.storage_id
                            ));
                            let admission = cancellation.child_token();
                            if let Err(failure) = await_index(
                                self.index.index_hot_entry(
                                    &entry,
                                    &hot_id,
                                    &chunk.storage_id,
                                    &project,
                                    topic,
                                    &admission,
                                ),
                                &admission,
                            )
                            .await
                            {
                                eprintln!("[session-sync] hot index failed: {}", failure.code);
                            }
                        }
                        Err(code) => eprintln!("[session-sync] hot save failed: {code}"),
                        _ => {}
                    }
                    let admission = cancellation.child_token();
                    await_index(
                        self.index.index_transcript(
                            &chunk.index_text,
                            &chunk.storage_id,
                            &chunk.original_id,
                            &project,
                            &admission,
                        ),
                        &admission,
                    )
                    .await
                    .map_err(|failure| failure.code.to_owned())?;
                }
            }
            offsets.insert(key, next);
            visited += 1;
        }
        if visited > 0 {
            tokio::task::spawn_blocking(move || offsets.save(&data_root, &memory_root))
                .await
                .map_err(|_| "legacy_session_offset_write_failed".to_owned())?
                .map_err(|failure| failure.code.to_owned())?;
        }
        println!("[session-sync] legacySessions={visited}");
        Ok(())
    }
}

async fn await_index<F>(future: F, cancellation: &CancellationToken) -> CognitionResult<()>
where
    F: Future<Output = CognitionResult<()>>,
{
    tokio::pin!(future);
    tokio::select! {
        result = &mut future => result,
        _ = tokio::time::sleep(Duration::from_secs(120)) => {
            cancellation.cancel();
            // A Lance mutation already admitted must finish while its write lease remains held.
            let _ = future.await;
            Err(CognitionError::new("legacy_session_index_timeout", "legacy_session_index_timeout"))
        }
    }
}
