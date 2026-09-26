//! App-owned session execution-control views and patches.

use serde::Serialize;

use super::{
    AppApplication, GatewayApplicationError, app_error, settings, storage::AppStorageError,
};
use crate::gateway::SessionControlState;

#[derive(Clone, Debug, Default)]
pub(crate) struct AppSessionControlUpdate {
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub access_mode: Option<String>,
    pub plan_mode: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct AppSessionControlsView {
    pub session_id: String,
    pub controls: SessionControlState,
    pub revision: u64,
    pub catalog_generation: String,
}

impl AppApplication {
    pub(super) async fn get_session_controls_view_owned(
        &self,
        session_id: String,
    ) -> Result<AppSessionControlsView, GatewayApplicationError> {
        self.dependencies.settings_facts.refresh().await?;
        let facts = self.dependencies.settings_facts.snapshot()?;
        let subscribers = self.subscribers.clone();
        let closure_facts = facts.clone();
        let chat_id = session_id.clone();
        let now = self.dependencies.identity_clock.now_iso();
        let (controls, revision) = self
            .storage
            .execute(move |db| {
                settings::session_controls_view(db, &subscribers, &closure_facts, &chat_id, &now)
            })
            .await
            .map_err(app_error)?;
        Ok(AppSessionControlsView {
            session_id,
            controls,
            revision,
            catalog_generation: facts.catalog_generation.clone(),
        })
    }

    pub(super) async fn update_session_controls_view_owned(
        &self,
        session_id: String,
        update: AppSessionControlUpdate,
    ) -> Result<AppSessionControlsView, GatewayApplicationError> {
        validate_update(&update)?;
        let _update = self.settings_update_lock.lock().await;
        self.dependencies.settings_facts.refresh().await?;
        let facts = self.dependencies.settings_facts.snapshot()?;
        let subscribers = self.subscribers.clone();
        let closure_facts = facts.clone();
        let chat_id = session_id.clone();
        let now = self.dependencies.identity_clock.now_iso();
        let (controls, revision) = self
            .storage
            .execute(move |db| {
                let transaction = db.transaction().map_err(AppStorageError::sqlite)?;
                let snapshot = settings::update_session_controls(
                    &transaction,
                    &subscribers,
                    &closure_facts,
                    &chat_id,
                    &update,
                    &now,
                )?;
                transaction.commit().map_err(AppStorageError::sqlite)?;
                Ok(snapshot)
            })
            .await
            .map_err(app_error)?;
        Ok(AppSessionControlsView {
            session_id,
            controls,
            revision,
            catalog_generation: facts.catalog_generation.clone(),
        })
    }
}

fn validate_update(update: &AppSessionControlUpdate) -> Result<(), GatewayApplicationError> {
    if update
        .reasoning_effort
        .as_deref()
        .is_some_and(|value| !matches!(value, "none" | "low" | "medium" | "high" | "xhigh" | "max"))
        || update
            .access_mode
            .as_deref()
            .is_some_and(|value| !matches!(value, "full_access" | "ask_first" | "read_only"))
    {
        return Err(GatewayApplicationError::Public {
            status: 400,
            code: "invalid_session_controls".into(),
            message: "Session controls update contains unsupported fields.".into(),
        });
    }
    Ok(())
}
