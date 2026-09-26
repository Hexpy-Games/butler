//! Canonical App session reads composed with BTCC child projections.

mod helpers;
mod turn_projection;

use serde_json::{Map, Value, json};

use super::{
    AppApplication, AppSessionBranchQuery, AppSessionViewPage, AppWorkStreamQuery,
    GatewayApplicationError, app_session_hint,
};
use crate::gateway::{TurnRecord, TurnState, protocol::APP_PROTOCOL_VERSION};
use helpers::*;
use turn_projection::{project, read_latest};

impl AppApplication {
    pub(super) async fn session_view_owned(
        &self,
        session_id: String,
        page: AppSessionViewPage,
    ) -> Result<Value, GatewayApplicationError> {
        if is_child_session(&session_id) {
            return self.child_session_view(session_id, page).await;
        }
        self.refresh_message_projection_owned(session_id.clone())
            .await?;
        let session = self.get_session(session_id.clone()).await?;
        let project_workspace_path = self
            .project_workspace_path(session.project_id.clone())
            .await?;
        let branch = self
            .dependencies
            .session_workspaces
            .branch_info(
                AppSessionBranchQuery {
                    runtime_session_id: session.session_hint.clone(),
                    project_workspace_path,
                },
                tokio_util::sync::CancellationToken::new(),
            )
            .await?;
        let message_page = self
            .message_window(session_id.clone(), page.clone())
            .await?;
        let messages = message_page.view;
        let latest_with_progress = read_latest(self, session_id.clone()).await?;
        let artifacts = self.artifact_page(session_id.clone()).await?;
        let context = self.context_details_owned(session_id.clone()).await?;
        let event_cursor = self.latest_event_cursor_owned().await?;
        let subsessions = self
            .dependencies
            .subsessions
            .projection(app_session_hint(&session_id), None)
            .await?;
        let latest = latest_with_progress.as_ref().map(|(turn, _)| turn);
        let active = latest.filter(|turn| active_state(&turn.state));
        let work_streams = self
            .dependencies
            .work_streams
            .list_active(AppWorkStreamQuery {
                app_session_id: session.id.clone(),
                runtime_session_id: session.session_hint.clone(),
                current_turn_id: active.map(|turn| turn.id.clone()),
            })
            .await?;
        let latest_message = messages.messages.last();
        let suppress_progress_rows = latest.is_some_and(|turn| {
            turn.user_message_id.is_none()
                && matches!(&turn.state, &TurnState::Delivered)
                && latest_message.is_some_and(|message| {
                    matches!(&message.role, &crate::gateway::MessageRole::Assistant)
                        && message.turn_id.is_none()
                        && message.created_at.as_str() >= turn.created_at.as_str()
                })
        });
        let latest_turn_view = latest_with_progress
            .as_ref()
            .map(|(turn, progress)| {
                project(turn, progress.clone(), &session.id, suppress_progress_rows)
            })
            .transpose()?;
        let active_turn_view = active.and(latest_turn_view.as_ref()).cloned();
        let next_cursor = crate::json::saturating_u64(messages.next_cursor);
        let first_cursor = messages.messages.first().map(|message| message.cursor);
        let mut view = Map::new();
        view.insert("protocol_version".into(), json!(APP_PROTOCOL_VERSION));
        view.insert("session_id".into(), json!(session.id));
        view.insert("kind".into(), json!(session.kind));
        insert_some(
            &mut view,
            "project_id",
            session.project_id.clone().map(Value::String),
        );
        insert_some(&mut view, "branch_seed", session.branch_seed);
        view.insert("status".into(), json!(view_status(latest)));
        view.insert(
            "active_turn".into(),
            serialize_option(active_turn_view.as_ref())?,
        );
        view.insert(
            "latest_turn".into(),
            serialize_option(latest_turn_view.as_ref())?,
        );
        view.insert(
            "messages".into(),
            serde_json::to_value(&messages.messages).map_err(json_error)?,
        );
        view.insert(
            "message_window".into(),
            json!({
                "next_cursor": next_cursor,
                "complete": !message_page.has_more,
                "has_more": message_page.has_more,
                "previous_cursor": first_cursor,
            }),
        );
        copy(&mut view, "workers", &subsessions);
        copy(&mut view, "steward_children", &subsessions);
        view.insert("work_streams".into(), work_streams);
        view.insert("branch".into(), branch);
        view.insert("skills_used".into(), json!(session.skills_used));
        let automation_targets = self.automation_targets(session_id.clone()).await?;
        view.insert("automations".into(), automation_targets);
        view.insert(
            "artifacts".into(),
            serde_json::to_value(artifacts).map_err(json_error)?,
        );
        view.insert("context".into(), context);
        view.insert("errors".into(), json!(safe_errors(&messages.messages)));
        view.insert(
            "cursors".into(),
            json!({"messages":next_cursor,"events":event_cursor}),
        );
        view.insert(
            "generated_at".into(),
            json!(self.dependencies.identity_clock.now_iso()),
        );
        view.insert(
            "updated_at".into(),
            json!(
                latest
                    .map(|turn| turn.updated_at.as_str())
                    .or_else(|| latest_message.map(|message| message.updated_at.as_str()))
                    .unwrap_or(&session.updated_at)
            ),
        );
        Ok(Value::Object(view))
    }

    pub(super) async fn session_summary_owned(
        &self,
        session_id: String,
    ) -> Result<Value, GatewayApplicationError> {
        if is_child_session(&session_id) {
            return self.child_session_summary(session_id).await;
        }
        self.refresh_message_projection_owned(session_id.clone())
            .await?;
        let session = self.get_session(session_id.clone()).await?;
        let project_workspace_path = self
            .project_workspace_path(session.project_id.clone())
            .await?;
        let branch_info = self
            .dependencies
            .session_workspaces
            .branch_info(
                AppSessionBranchQuery {
                    runtime_session_id: session.session_hint.clone(),
                    project_workspace_path,
                },
                tokio_util::sync::CancellationToken::new(),
            )
            .await?;
        let messages = self.message_page(session_id.clone(), 0.0, 200).await?;
        let latest = self.latest_session_turn(session_id.clone()).await?;
        let artifacts = self.artifact_page(session_id.clone()).await?;
        let context_details = self.context_details_owned(session_id.clone()).await?;
        let subsessions = self
            .dependencies
            .subsessions
            .projection(app_session_hint(&session_id), None)
            .await?;
        let latest = latest.as_ref();
        let work_streams = self
            .dependencies
            .work_streams
            .list_active(AppWorkStreamQuery {
                app_session_id: session.id.clone(),
                runtime_session_id: session.session_hint.clone(),
                current_turn_id: latest
                    .filter(|turn| active_state(&turn.state))
                    .map(|turn| turn.id.clone()),
            })
            .await?;
        let progress = latest
            .and_then(|turn| messages.turn_progress.as_ref()?.get(&turn.id))
            .map(serde_json::to_value)
            .transpose()
            .map_err(json_error)?
            .unwrap_or_else(|| {
                json!({
                    "summary": if messages.messages.is_empty() {"No progress yet"} else {"Latest message delivered"},
                    "updated_at": latest.map(|turn|turn.updated_at.as_str()).unwrap_or(&session.updated_at),
                    "state": latest.map(|turn| turn_state_name(&turn.state)).unwrap_or("idle"),
                    "safe_progress_rows": [],
                })
            });
        let mut view = Map::new();
        view.insert("session_id".into(), json!(session.id));
        insert_some(&mut view, "branch_seed", session.branch_seed);
        view.insert("latest_progress".into(), progress);
        if let Some(turn) = latest {
            view.insert(
                "latest_turn".into(),
                serde_json::to_value(turn).map_err(json_error)?,
            );
            view.insert("latest_turn_cancellable".into(), json!(turn.cancellable));
        }
        view.insert(
            "turn_state".into(),
            json!(
                latest
                    .map(|turn| turn_state_name(&turn.state))
                    .unwrap_or("idle")
            ),
        );
        view.insert(
            "artifacts".into(),
            serde_json::to_value(artifacts).map_err(json_error)?,
        );
        view.insert("context_details".into(), context_details);
        view.insert("safe_errors".into(), json!(safe_errors(&messages.messages)));
        view.insert("branch_info".into(), branch_info);
        view.insert("skills_used".into(), json!(session.skills_used));
        let automation_targets = self.automation_targets(session_id.clone()).await?;
        view.insert("automation_targets".into(), automation_targets);
        view.insert("work_streams".into(), work_streams);
        copy_as(&mut view, "worker_activity", "workers", &subsessions);
        copy(&mut view, "steward_children", &subsessions);
        view.insert(
            "staleness".into(),
            json!({"state":"fresh","updated_at":self.dependencies.identity_clock.now_iso(),"source":"app-server"}),
        );
        Ok(Value::Object(view))
    }

    async fn child_session_view(
        &self,
        session_id: String,
        page: AppSessionViewPage,
    ) -> Result<Value, GatewayApplicationError> {
        let requested_after = page.after_cursor.unwrap_or(0);
        let projection = self
            .dependencies
            .subsessions
            .projection(session_id.clone(), Some(page))
            .await?;
        require_relation(&projection)?;
        let messages = projection
            .get("messages")
            .cloned()
            .unwrap_or_else(|| json!([]));
        let next_cursor = messages
            .as_array()
            .and_then(|messages| messages.last())
            .and_then(|message| message.get("cursor"))
            .and_then(Value::as_u64)
            .unwrap_or(requested_after);
        let previous_cursor = messages
            .as_array()
            .and_then(|messages| messages.first())
            .and_then(|message| message.get("cursor"))
            .and_then(Value::as_u64);
        let has_more = projection
            .get("messages_has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut view = Map::new();
        view.insert("protocol_version".into(), json!(APP_PROTOCOL_VERSION));
        view.insert("session_id".into(), json!(session_id));
        view.insert("kind".into(), json!("chat"));
        view.insert("status".into(), json!(child_status(&projection)));
        for key in [
            "active_turn",
            "latest_turn",
            "messages",
            "workers",
            "relation",
        ] {
            copy(&mut view, key, &projection);
        }
        view.insert(
            "message_window".into(),
            json!({"next_cursor":next_cursor,"previous_cursor":previous_cursor,"complete":!has_more,"has_more":has_more}),
        );
        view.insert("context".into(), Value::Null);
        view.insert("skills_used".into(), json!([]));
        view.insert(
            "cursors".into(),
            json!({"messages":next_cursor,"events":self.latest_event_cursor_owned().await?}),
        );
        let updated = child_updated_at(&projection).ok_or(GatewayApplicationError::Internal)?;
        view.insert(
            "generated_at".into(),
            json!(self.dependencies.identity_clock.now_iso()),
        );
        view.insert("updated_at".into(), json!(updated));
        if let Some(parent) = projection.pointer("/relation/parent_session_id") {
            view.insert("parent_session_id".into(), parent.clone());
        }
        Ok(Value::Object(view))
    }

    async fn child_session_summary(
        &self,
        session_id: String,
    ) -> Result<Value, GatewayApplicationError> {
        let projection = self
            .dependencies
            .subsessions
            .projection(
                session_id.clone(),
                Some(AppSessionViewPage {
                    after_cursor: None,
                    before_cursor: None,
                    limit: 200,
                }),
            )
            .await?;
        require_relation(&projection)?;
        let latest = projection
            .get("latest_turn")
            .cloned()
            .unwrap_or(Value::Null);
        let updated = child_updated_at(&projection).ok_or(GatewayApplicationError::Internal)?;
        let mut view = Map::new();
        view.insert("session_id".into(), json!(session_id));
        view.insert("latest_turn".into(), latest.clone());
        view.insert(
            "turn_state".into(),
            latest
                .get("state")
                .cloned()
                .unwrap_or_else(|| json!("idle")),
        );
        view.insert(
            "latest_progress".into(),
            json!({
                "summary": projection.pointer("/result/summary").and_then(Value::as_str).unwrap_or("No progress yet"),
                "updated_at": updated,
                "state": latest.get("state").cloned().unwrap_or_else(||json!("idle")),
            }),
        );
        view.insert(
            "context_details".into(),
            json!({
                "session_id":session_id,"used_tokens":0,"budget_tokens":0,"ratio":0,
                "status":"low","categories":[],"token_count_source":"unavailable",
                "updated_at":updated,
            }),
        );
        view.insert("skills_used".into(), json!([]));
        copy_as(&mut view, "worker_activity", "workers", &projection);
        copy(&mut view, "relation", &projection);
        view.insert(
            "staleness".into(),
            json!({"state":"fresh","updated_at":updated,"source":"btcc-native"}),
        );
        Ok(Value::Object(view))
    }

    pub(super) async fn refresh_message_projection_owned(
        &self,
        session_id: String,
    ) -> Result<(), GatewayApplicationError> {
        self.projection.refresh(session_id).await
    }

    async fn latest_event_cursor_owned(&self) -> Result<u64, GatewayApplicationError> {
        self.storage
            .execute(|db| super::events::latest(db))
            .await
            .map_err(super::app_error)
    }

    pub(super) async fn message_window(
        &self,
        session_id: String,
        page: AppSessionViewPage,
    ) -> Result<super::read_model::SessionMessagePage, GatewayApplicationError> {
        self.storage
            .execute(move |db| {
                super::read_model::list_message_page(
                    db,
                    &session_id,
                    page.after_cursor,
                    page.before_cursor,
                    page.limit,
                )
            })
            .await
            .map_err(super::app_error)
    }

    pub(super) async fn latest_session_turn(
        &self,
        session_id: String,
    ) -> Result<Option<TurnRecord>, GatewayApplicationError> {
        self.storage
            .execute(move |db| super::read_model::latest_turn(db, &session_id))
            .await
            .map_err(super::app_error)
    }
}
