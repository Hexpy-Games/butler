//! Bind an App session to the current native execution context when needed.

use rusqlite::OptionalExtension;

use super::super::{AppApplication, AppRelocationBindingSeed, AppStorageError, app_error};
use crate::gateway::GatewayApplicationError;

impl AppApplication {
    pub(super) async fn binding_seed(
        &self,
        session_id: &str,
    ) -> Result<AppRelocationBindingSeed, GatewayApplicationError> {
        let session_id = session_id.to_owned();
        let data_root = self.butler_data.to_string_lossy().into_owned();
        let facts = self.dependencies.settings_facts.snapshot()?;
        let subscribers = self.subscribers.clone();
        let clock = self.dependencies.identity_clock.clone();
        self.storage
            .execute(move |db| {
                let session = super::super::sessions::read_summary(db, &session_id)?;
                let settings = super::super::settings::session_workspace_settings(
                    db,
                    &subscribers,
                    &facts,
                    &clock.now_iso(),
                )?;
                let model_ref = settings.model;
                let Some((provider, model)) = model_ref.split_once('/') else {
                    return Err(AppStorageError::new(
                        "model_not_configured",
                        "The session model is not configured.",
                    ));
                };
                if provider.is_empty() || model.is_empty() {
                    return Err(AppStorageError::new(
                        "model_not_configured",
                        "The session model is not configured.",
                    ));
                }
                let project = session
                    .project_id
                    .as_deref()
                    .map(|id| {
                        db.query_row(
                            "SELECT workspace_path,ledger_project_id FROM projects WHERE id=?1",
                            [id],
                            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                        )
                        .optional()
                        .map_err(AppStorageError::sqlite)
                    })
                    .transpose()?
                    .flatten();
                let (workspace_path, ledger_project_id) = project.unwrap_or((data_root, None));
                Ok(AppRelocationBindingSeed {
                    runtime_session_id: crate::gateway::app_session_hint(&session.id),
                    project_id: session.project_id,
                    ledger_project_id,
                    workspace_path,
                    model_provider_id: provider.to_owned(),
                    model_ref,
                })
            })
            .await
            .map_err(app_error)
    }
}
