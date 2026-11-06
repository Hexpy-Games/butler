//! Session actions and frame settings through the existing ShellClient worker.
use super::{Agent, convert};
use crate::ui::source::{Fetch, SessionId, wire};

impl Agent {
    pub(super) fn frame_summary(&self, session: &SessionId) -> Fetch<wire::SessionSummaryView> {
        let (client, session) = (self.client.clone(), session.0.to_string());
        self.fetch(async move { convert::decode(&client.get_session_summary(&session).await?) })
    }
    pub(super) fn frame_settings(&self) -> Fetch<wire::FrameSettings> {
        let client = self.client.clone();
        self.fetch(async move { convert::decode(&client.get_settings().await?) })
    }
    pub(super) fn frame_action(
        &self,
        session: &SessionId,
        action: super::super::SessionAction,
    ) -> Fetch<()> {
        let (client, session) = (self.client.clone(), session.0.to_string());
        self.fetch(async move {
            match action {
                super::super::SessionAction::Rename(title) => {
                    client
                        .update_session(&session, &serde_json::json!({"title": title}))
                        .await
                }
                super::super::SessionAction::Archive => client.archive_session(&session).await,
                super::super::SessionAction::Delete => {
                    client.delete_session_permanent(&session).await
                }
            }
            .map(|_| ())
        })
    }
}
