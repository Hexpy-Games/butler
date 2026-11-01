//! Every route that removes a conversation (archive, delete, project archive and
//! delete) stops what it was running here.
use super::*;
use crate::gateway::AppCanonOperation;
use crate::gateway::application::AppCancellation;

impl AppApplication {
    /// Nothing can answer or watch a removed conversation, so its Turns and whole
    /// delegated subtree stop with it. A failed stop never blocks the removal.
    /// A chat that survives, archived, also holds its steps; a deleted chat's steps go with it.
    pub(in crate::gateway::application) async fn stop_session_work(
        &self,
        session_id: &str,
        chat_survives: bool,
    ) {
        let stopped = self.stop_app_turns(session_id).await;
        let runtime = match self.runtime_hint(session_id).await {
            Ok(runtime) => runtime,
            Err(error) => {
                tracing::warn!(%error, "Work of a removed conversation was not found");
                return;
            }
        };
        // The waiting parents stop first, so a stopped child cannot resume them.
        self.stop_waiting_turns(session_id, &runtime, &stopped)
            .await;
        if let Err(error) = self
            .dependencies
            .subsessions
            .cancel_subtree(runtime.clone())
            .await
        {
            tracing::warn!(%error, "Subtasks of a removed conversation were not stopped");
        }
        if !chat_survives {
            return;
        }
        // A step that only waited on delegated work has no App Turn to report its end.
        if let Err(error) = self
            .dependencies
            .canon
            .canon_operation(AppCanonOperation::Queue {
                session_id: runtime,
                action: "stop_running".into(),
                input: serde_json::json!({}),
            })
            .await
        {
            tracing::warn!(%error, "Steps of a removed conversation were not held");
        }
    }

    async fn stop_app_turns(&self, session_id: &str) -> Vec<String> {
        let chat = session_id.to_owned();
        let turns = self
            .storage
            .read(move |db| {
                let mut statement = db
                    .prepare_cached(
                        "SELECT id FROM turns WHERE chat_id=?1 AND state NOT IN ('delivered','cancelled','failed','runtime_fault')",
                    )
                    .map_err(AppStorageError::sqlite)?;
                let rows = statement
                    .query_map([chat], |row| row.get::<_, String>(0))
                    .map_err(AppStorageError::sqlite)?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(AppStorageError::sqlite)
            })
            .await;
        let turns = turns.unwrap_or_else(|error| {
            tracing::warn!(%error, "Turns of a removed conversation were not found");
            Vec::new()
        });
        for turn in &turns {
            // A Turn that is past stopping finishes on its own.
            if let Err(error) = self.cancel_turn_owned(turn.clone()).await {
                tracing::warn!(%error, "Turn of a removed conversation was not stopped");
            }
        }
        turns
    }

    async fn stop_waiting_turns(&self, chat: &str, runtime: &str, stopped: &[String]) {
        let waiting = self
            .dependencies
            .subsessions
            .turns_waiting_on_delegation(runtime.to_owned())
            .await;
        let waiting = waiting.unwrap_or_else(|error| {
            tracing::warn!(%error, "Waiting Turns of a removed conversation were not found");
            Vec::new()
        });
        for turn in waiting.into_iter().filter(|turn| !stopped.contains(turn)) {
            let cancel = AppCancellation {
                chat_id: chat.to_owned(),
                session_id: runtime.to_owned(),
                request_id: format!("cancel:{turn}"),
                turn_id: turn,
                requested_at: self.dependencies.identity_clock.now_iso(),
                app_queue_claim_id: None,
            };
            if let Err(error) = self
                .dependencies
                .native_ingress
                .enqueue_cancel(cancel)
                .await
            {
                tracing::warn!(%error, "Waiting Turn of a removed conversation was not stopped");
            }
        }
    }
}
