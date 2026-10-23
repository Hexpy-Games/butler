//! Smart groups: after a conversation's first message, a bounded background
//! classification files it into a matching group or pairs it with a
//! conversation on the same subject. Every step re-checks eligibility, and
//! any failure leaves the conversation where it is.
mod apply;
mod candidates;
mod classification;

use super::*;
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use tracing::Instrument;

use candidates::Prepared;
use classification::Classification;

#[derive(Clone, Default)]
pub(super) struct SmartGroupOwner {
    tasks: TaskTracker,
    cancellation: CancellationToken,
}

impl SmartGroupOwner {
    pub(super) async fn close(&self) {
        self.cancellation.cancel();
        self.tasks.close();
        self.tasks.wait().await;
    }
}

impl AppApplication {
    pub(super) fn organize_session(&self, chat: String, model: String) {
        if chat == "general" || chat.starts_with("steward-") || chat.starts_with("worker-") {
            return;
        }
        let app = self.clone_handle();
        let cancellation = self.smart_groups.cancellation.child_token();
        let context = butler_log::TraceContext::current();
        let span = tracing::info_span!(parent: None, "session.smart_group",
            trace_id = context.trace_id.as_deref(), turn_id = context.turn_id.as_deref(),
            chat_id = context.chat_id.as_deref(), message_id = context.message_id.as_deref());
        span.follows_from(tracing::Span::current());
        self.smart_groups.tasks.spawn(async move {
            let result = tokio::select! {
                biased;
                () = cancellation.cancelled() => return,
                () = app.dependencies.service_shutdown.cancelled() => { cancellation.cancel(); return },
                result = app.classify_and_apply(&chat, &model, cancellation.clone()) => result,
            };
            cancellation.cancel();
            if let Err(reason) = result {
                eprintln!("WARN [smart-group] chat={chat} reason={reason}");
            }
        }.instrument(span));
    }

    async fn classify_and_apply(
        &self,
        chat: &str,
        model: &str,
        cancellation: CancellationToken,
    ) -> Result<(), &'static str> {
        let id = chat.to_owned();
        let prepared = self
            .storage
            .read(move |db| candidates::prepare(db, &id))
            .await
            .map_err(|_| "storage")?;
        let Some(prepared) = prepared else {
            return Ok(());
        };
        let reply = self
            .dependencies
            .session_topic_classifier
            .classify(
                AppSessionTopicInput {
                    usage_session_id: Some(prepared.usage_session.clone()),
                    request_json: classification::request(&prepared),
                    model_ref: model.to_owned(),
                },
                cancellation.clone(),
            )
            .await
            .map_err(|_| "provider")?;
        let classification =
            classification::parse(&reply, &prepared.candidates).ok_or("invalid_output")?;
        if cancellation.is_cancelled() {
            return Ok(());
        }
        self.apply_classification(chat, &prepared, classification)
            .await
    }

    /// Applies through the space owner with the revision read at apply time;
    /// a concurrent space change gets one fresh re-check and retry.
    async fn apply_classification(
        &self,
        chat: &str,
        prepared: &Prepared,
        classification: Classification,
    ) -> Result<(), &'static str> {
        if classification.topic.is_none() {
            return Ok(());
        }
        let expected = apply::Expected {
            chat: chat.to_owned(),
            message_id: prepared.message_id.clone(),
            node_revision: prepared.node_revision,
            classification,
        };
        let expected = std::sync::Arc::new(expected);
        for attempt in 0..2 {
            let now = self.dependencies.identity_clock.now_iso();
            let input = expected.clone();
            let plan = self
                .storage
                .execute(move |db| apply::plan(db, &input, &now))
                .await
                .map_err(|_| "storage")?;
            let Some(plan) = plan else {
                return Ok(());
            };
            match self
                .mutate_space_owned(plan.command, AppSpaceOrigin::Smart, Some(plan.title))
                .await
            {
                Ok(_) => return Ok(()),
                Err(GatewayApplicationError::Public { code, .. })
                    if code == "space_changed" && attempt == 0 => {}
                Err(_) => return Err("mutation"),
            }
        }
        Err("space_changed")
    }
}

/// A classifier that never files a conversation, for tests without a model.
#[cfg(test)]
pub(super) struct NoTopicClassifier;

#[cfg(test)]
impl AppSessionTopicClassifier for NoTopicClassifier {
    fn classify(
        &self,
        _input: AppSessionTopicInput,
        _cancellation: CancellationToken,
    ) -> ApplicationFuture<String> {
        Box::pin(async { Ok(r#"{"topic":null,"action":"none","target":null}"#.into()) })
    }
}
