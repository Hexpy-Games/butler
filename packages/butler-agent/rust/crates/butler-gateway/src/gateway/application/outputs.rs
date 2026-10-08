//! Output projections share the existing artifact/message ingress on every client.
use super::{AppApplication, GatewayApplicationError, app_error, read_model};
use crate::gateway::{ArtifactKind, ArtifactOpenAction, MessageRecord, SessionArtifactSummary};
use butler_runtime::outputs::OutputStore;

impl AppApplication {
    pub(super) async fn message_page(
        &self,
        chat_id: String,
        cursor: f64,
        limit: usize,
    ) -> Result<crate::gateway::MessageListView, GatewayApplicationError> {
        let session = chat_id.clone();
        let mut page = self
            .storage
            .read(move |db| read_model::list_messages(db, &chat_id, cursor, limit))
            .await
            .map_err(app_error)?;
        let outputs = self
            .output_message_artifacts(session, &page.messages)
            .await?;
        decorate(&mut page.messages, &outputs);
        Ok(page)
    }
    pub(super) async fn artifact_page(
        &self,
        session_id: String,
    ) -> Result<Vec<crate::gateway::SessionArtifactSummary>, GatewayApplicationError> {
        let outputs = self.output_artifacts(session_id.clone()).await?;
        let mut artifacts = self
            .storage
            .read(move |db| read_model::list_artifacts(db, &session_id))
            .await
            .map_err(app_error)?;
        artifacts.extend(outputs);
        Ok(artifacts)
    }

    pub(super) async fn output_artifacts(
        &self,
        session: String,
    ) -> Result<Vec<SessionArtifactSummary>, GatewayApplicationError> {
        self.output_projection(session, None).await
    }
    pub(super) async fn output_message_artifacts(
        &self,
        session: String,
        messages: &[MessageRecord],
    ) -> Result<Vec<SessionArtifactSummary>, GatewayApplicationError> {
        let turns = messages.iter().filter_map(|m| m.turn_id.clone()).collect();
        self.output_projection(session, Some(turns)).await
    }
    async fn output_projection(
        &self,
        session: String,
        turns: Option<Vec<String>>,
    ) -> Result<Vec<SessionArtifactSummary>, GatewayApplicationError> {
        let store = OutputStore::new(&self.butler_data);
        tokio::task::spawn_blocking(move || {
            let result = match turns {
                Some(turns) => store.message_summaries(&session, &turns),
                None => store.summaries(&session),
            };
            result.map(|outputs| {
                outputs
                    .into_iter()
                    .map(|o| SessionArtifactSummary {
                        id: o.output_id.clone(),
                        session_id: Some(o.session_id),
                        project_id: None,
                        message_id: Some(o.message_id),
                        turn_id: Some(o.turn_id),
                        file_id: None,
                        kind: ArtifactKind::Web,
                        title: o.title,
                        safe_path_label: None,
                        url: Some(format!("/outputs/{}/view", o.output_id)),
                        size_bytes: Some(o.size_bytes),
                        created_at: o.created_at,
                        open_action: Some(ArtifactOpenAction::Route),
                    })
                    .collect()
            })
        })
        .await
        .map_err(GatewayApplicationError::internal_from)?
        .map_err(GatewayApplicationError::internal_from)
    }
    pub(super) async fn recover_output_transfers(&self) -> Result<(), GatewayApplicationError> {
        let pending = self
            .storage
            .read(|db| {
                let mut query = db
                    .prepare("SELECT archive_id FROM app_output_transfers ORDER BY rowid")
                    .map_err(super::AppStorageError::sqlite)?;
                query
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(super::AppStorageError::sqlite)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(super::AppStorageError::sqlite)
            })
            .await
            .map_err(app_error)?;
        for archive in pending {
            let store = OutputStore::new(&self.butler_data);
            let target = archive.clone();
            tokio::task::spawn_blocking(move || store.transfer_session("general", &target))
                .await
                .map_err(GatewayApplicationError::internal_from)?
                .map_err(GatewayApplicationError::internal_from)?;
            self.storage.execute(move |db| {
                let tx = db.savepoint().map_err(super::AppStorageError::sqlite)?;
                tx.execute("DELETE FROM app_output_transfers WHERE archive_id=?1", [&archive])
                    .map_err(super::AppStorageError::sqlite)?;
                tx.execute("DELETE FROM app_session_context_gate WHERE session_id='general' AND owner_kind='relocate' AND owner_id=?1", [&archive])
                    .map_err(super::AppStorageError::sqlite)?;
                tx.commit().map_err(super::AppStorageError::sqlite)
            }).await.map_err(app_error)?;
        }
        Ok(())
    }
    pub(super) async fn collect_session_outputs(
        &self,
        session: String,
    ) -> Result<(), GatewayApplicationError> {
        let store = OutputStore::new(&self.butler_data);
        tokio::task::spawn_blocking(move || store.remove_session(&session))
            .await
            .map_err(GatewayApplicationError::internal_from)?
            .map_err(GatewayApplicationError::internal_from)
    }
}
pub(super) fn decorate(messages: &mut [MessageRecord], outputs: &[SessionArtifactSummary]) {
    for output in outputs {
        let target = messages.iter_mut().rev().find(|m| {
            matches!(m.role, crate::gateway::MessageRole::Assistant) && m.turn_id == output.turn_id
        });
        if let Some(message) = target {
            message
                .artifacts
                .get_or_insert_with(Vec::new)
                .push(output.clone());
        }
    }
}
