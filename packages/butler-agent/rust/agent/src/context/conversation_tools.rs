//! Public conversation tools; canonical reads stay owned by Conversation.

mod list;
#[cfg(test)]
mod tests;

use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::{Semaphore, oneshot};
use tokio_util::task::TaskTracker;

use super::{
    ContextConversation, ContextError, ContextResult, ConversationContextDirection,
    ReadConversationContextInput,
};
use crate::conversation::{CanonicalMemoryReadBinding, conversation_store_path};

pub(crate) struct NativeConversationTools {
    path: PathBuf,
    data_root: PathBuf,
    conversation: Arc<ContextConversation>,
    permits: Arc<Semaphore>,
    jobs: TaskTracker,
    closing: Mutex<bool>,
}

impl NativeConversationTools {
    pub(crate) fn new(
        data_root: PathBuf,
        conversation: Arc<ContextConversation>,
        read_concurrency: usize,
    ) -> Self {
        Self {
            path: conversation_store_path(&data_root),
            data_root,
            conversation,
            permits: Arc::new(Semaphore::new(read_concurrency.max(1))),
            jobs: TaskTracker::new(),
            closing: Mutex::new(false),
        }
    }

    pub(crate) async fn list(
        &self,
        binding: CanonicalMemoryReadBinding,
        args: Value,
    ) -> ContextResult<Value> {
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ContextError::new("closed", "Conversation tools are closing"))?;
        let path = self.path.clone();
        let data_root = self.data_root.clone();
        let (tx, rx) = oneshot::channel();
        {
            let closing = self
                .closing
                .lock()
                .expect("conversation tools owner poisoned");
            if *closing {
                return Err(ContextError::new(
                    "closed",
                    "Conversation tools are closing",
                ));
            }
            self.jobs.spawn(async move {
                let result = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    list::run(&path, &data_root, &binding, &args)
                })
                .await
                .unwrap_or_else(|error| {
                    Err(ContextError::new(
                        "conversation_list_join_failed",
                        error.to_string(),
                    ))
                });
                let _ = tx.send(result);
            });
        }
        rx.await.map_err(|_| {
            ContextError::new(
                "conversation_list_completion_lost",
                "Conversation list completion lost",
            )
        })?
    }

    pub(crate) async fn read_context(
        &self,
        runtime_session_id: String,
        args: Value,
    ) -> ContextResult<Value> {
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ContextError::new("closed", "Conversation tools are closing"))?;
        let conversation = self.conversation.clone();
        let (tx, rx) = oneshot::channel();
        {
            let closing = self
                .closing
                .lock()
                .expect("conversation tools owner poisoned");
            if *closing {
                return Err(ContextError::new(
                    "closed",
                    "Conversation tools are closing",
                ));
            }
            self.jobs.spawn(async move {
                let _permit = permit;
                let direction = match args.get("direction").and_then(Value::as_str) {
                    Some("before") => Some(ConversationContextDirection::Before),
                    Some("after") => Some(ConversationContextDirection::After),
                    Some("around") => Some(ConversationContextDirection::Around),
                    _ => None,
                };
                let optional_string =
                    |key| args.get(key).and_then(Value::as_str).map(str::to_owned);
                let optional_number = |key| args.get(key).and_then(Value::as_f64);
                let input = ReadConversationContextInput {
                    session_id: runtime_session_id,
                    gateway: None,
                    query: optional_string("query"),
                    anchor_message_id: optional_string("anchor_message_id"),
                    anchor_event_id: optional_string("anchor_event_id"),
                    direction,
                    limit: optional_number("limit"),
                    max_chars: optional_number("max_chars"),
                    include_tools: args.get("include_tools") == Some(&Value::Bool(true)),
                    validated_limits: None,
                    include_internal: false,
                };
                let result = conversation
                    .read_conversation_context(input)
                    .await
                    .and_then(|result| {
                        serde_json::to_value(result).map_err(|error| {
                            ContextError::new(
                                "conversation_context_serialize_failed",
                                error.to_string(),
                            )
                        })
                    });
                let _ = tx.send(result);
            });
        }
        rx.await.map_err(|_| {
            ContextError::new(
                "conversation_context_completion_lost",
                "Conversation context completion lost",
            )
        })?
    }

    pub(crate) async fn close(&self) -> ContextResult<()> {
        {
            let mut closing = self
                .closing
                .lock()
                .expect("conversation tools owner poisoned");
            *closing = true;
            self.permits.close();
            self.jobs.close();
        }
        self.jobs.wait().await;
        Ok(())
    }
}
