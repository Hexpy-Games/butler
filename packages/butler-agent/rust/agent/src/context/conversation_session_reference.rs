//! V2 source-reference and session reads over a pinned canonical Conversation view.

mod args;
mod session;
mod source;
#[cfg(test)]
mod tests;

use parking_lot::Mutex;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::Value;
use tokio::sync::{Semaphore, oneshot};
use tokio_util::task::TaskTracker;

use crate::conversation::{
    CanonicalMemoryReadBinding, PublicMemorySnapshot, conversation_store_path,
};

use super::{ContextError, ContextResult, MemorySourceReferencePort, ResolvedMemorySource};

pub(crate) struct NativeConversationSessionReference {
    path: PathBuf,
    memory_sources: Arc<dyn MemorySourceReferencePort>,
    permits: Arc<Semaphore>,
    jobs: TaskTracker,
    closing: Mutex<bool>,
}

impl NativeConversationSessionReference {
    pub(crate) fn new(
        data_root: &Path,
        read_concurrency: usize,
        memory_sources: Arc<dyn MemorySourceReferencePort>,
    ) -> Self {
        Self {
            path: conversation_store_path(data_root),
            memory_sources,
            permits: Arc::new(Semaphore::new(read_concurrency.max(1))),
            jobs: TaskTracker::new(),
            closing: Mutex::new(false),
        }
    }

    pub(crate) async fn read(
        &self,
        binding: CanonicalMemoryReadBinding,
        args: Value,
    ) -> ContextResult<Value> {
        let permit =
            self.permits.clone().acquire_owned().await.map_err(|_| {
                ContextError::new("closed", "Conversation reference reader is closing")
            })?;
        let path = self.path.clone();
        let memory_sources = self.memory_sources.clone();
        let (sender, receiver) = oneshot::channel();
        {
            let closing = self.closing.lock();
            if *closing {
                return Err(ContextError::new(
                    "closed",
                    "Conversation reference reader is closing",
                ));
            }
            self.jobs.spawn(async move {
                let result = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    read_now(&path, memory_sources.as_ref(), &binding, &args)
                })
                .await
                .unwrap_or_else(|e| Err(ContextError::new("reference_join_failed", e.to_string())));
                let _ = sender.send(result);
            });
        }
        receiver.await.map_err(|_| {
            ContextError::new(
                "reference_completion_lost",
                "Conversation reference read lost",
            )
        })?
    }

    pub(crate) async fn close(&self) -> ContextResult<()> {
        {
            let mut closing = self.closing.lock();
            *closing = true;
            self.permits.close();
            self.jobs.close();
        }
        self.jobs.wait().await;
        Ok(())
    }
}

fn read_now(
    path: &std::path::Path,
    memory_sources: &dyn MemorySourceReferencePort,
    binding: &CanonicalMemoryReadBinding,
    input: &Value,
) -> ContextResult<Value> {
    let source_ref = input
        .get("source_ref")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let session_id = input
        .get("conversation_session_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if source_ref.is_empty() == session_id.is_empty() {
        return Ok(args::failure(
            "invalid_arguments",
            &[if source_ref.is_empty() {
                "source_locator_required"
            } else {
                "source_locator_conflict"
            }],
        ));
    }
    if !source_ref.is_empty() {
        if ["anchor_message_id", "direction", "include_tools", "limit"]
            .iter()
            .any(|key| input.get(*key).is_some())
        {
            return Ok(args::failure(
                "invalid_arguments",
                &["source_mode_options_not_allowed"],
            ));
        }
    } else if input.get("cursor").is_some() {
        return Ok(args::failure(
            "invalid_arguments",
            &["session_cursor_not_allowed"],
        ));
    }
    let snapshot = match PublicMemorySnapshot::open(path, binding) {
        Ok(snapshot) => snapshot,
        Err(error) if error.code() == "invalid_scope" => {
            return Ok(args::failure("invalid_scope", &[]));
        }
        Err(_) => {
            return Ok(args::failure(
                "backend_unavailable",
                &["conversation_store_unavailable"],
            ));
        }
    };
    let parsed = match args::parse(
        input,
        &snapshot.current_session_id,
        binding.project_id.as_deref(),
    ) {
        Ok(parsed) => parsed,
        Err(error) => {
            return Ok(args::failure(
                error,
                if error == "invalid_arguments" {
                    &["invalid_arguments"]
                } else {
                    &[]
                },
            ));
        }
    };
    if !snapshot
        .validate_scope(&parsed.scope)
        .map_err(store_error)?
    {
        return Ok(args::failure("invalid_scope", &[]));
    }
    if source_ref.starts_with("memory-source:v2:") {
        let session_read_failed = std::cell::Cell::new(false);
        let output = memory_sources.resolve(source_ref, &|candidate| {
            let session_project = if candidate.project_id.is_none() {
                candidate.conversation_session_id.as_deref().and_then(|id| {
                    match snapshot.session(id) {
                        Ok(session) => session.and_then(|session| session.project_id),
                        Err(_) => {
                            session_read_failed.set(true);
                            None
                        }
                    }
                })
            } else {
                None
            };
            let project_id = candidate
                .project_id
                .as_deref()
                .or(session_project.as_deref());
            snapshot.permits(
                &parsed.scope,
                candidate.conversation_session_id.as_deref().unwrap_or(""),
                project_id,
            ) && (parsed.scope.include_internal
                || matches!(
                    candidate.source_kind.as_str(),
                    "task_report" | "explicit_record"
                )
                || matches!(
                    candidate.origin_kind.as_str(),
                    "user_input" | "assistant_public"
                ))
        });
        if session_read_failed.get() {
            return Ok(args::failure(
                "backend_unavailable",
                &["conversation_store_unavailable"],
            ));
        }
        let output = match output {
            Ok(resolved) => source::read_memory(&resolved, &parsed, source_ref, input),
            Err(error) => Err(error),
        };
        return match output {
            Ok(value) => Ok(value),
            Err(error) if matches!(error.code, "memory_source_not_found" | "source_not_found") => {
                Ok(args::failure("source_not_found", &[]))
            }
            Err(error) if matches!(error.code, "memory_source_changed" | "source_changed") => {
                Ok(args::failure("source_changed", &[]))
            }
            Err(error) if error.code == "stale_cursor" => Ok(args::failure("stale_cursor", &[])),
            Err(error) if error.code == "invalid_scope" => Ok(args::failure("invalid_scope", &[])),
            Err(error)
                if matches!(
                    error.code,
                    "invalid_integer" | "invalid_cursor" | "invalid_arguments"
                ) =>
            {
                Ok(args::failure("invalid_arguments", &[error.code]))
            }
            Err(_) => Ok(args::failure(
                "backend_unavailable",
                &["conversation_store_unavailable"],
            )),
        };
    }
    let output = if source_ref.is_empty() {
        session::read(&snapshot, &parsed, session_id, input)
    } else {
        source::read(&snapshot, &parsed, source_ref, input)
    };
    match output {
        Ok(output) if source_ref.is_empty() && output.get("ok") == Some(&Value::Bool(false)) => {
            Ok(args::failure("invalid_scope", &[]))
        }
        Ok(output) => Ok(output),
        Err(error)
            if [
                "source_not_found",
                "source_changed",
                "stale_cursor",
                "invalid_scope",
            ]
            .contains(&error.code) =>
        {
            Ok(args::failure(error.code, &[]))
        }
        Err(error)
            if ["invalid_arguments", "invalid_integer", "invalid_cursor"].contains(&error.code) =>
        {
            Ok(args::failure("invalid_arguments", &[error.code]))
        }
        Err(_) => Ok(args::failure(
            "backend_unavailable",
            &["conversation_store_unavailable"],
        )),
    }
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn store_error(error: crate::conversation::ConversationError) -> ContextError {
    ContextError::new("conversation_store_unavailable", error.to_string())
}
