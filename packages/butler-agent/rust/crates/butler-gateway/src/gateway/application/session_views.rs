//! Canonical App session reads composed with BTCC child projections.

mod helpers;
mod snapshot;
mod steward_children;
mod turn_projection;

use serde_json::{Map, Value, json};

use super::{
    AppApplication, AppSessionBranchQuery, AppSessionViewPage, AppWorkStreamQuery,
    GatewayApplicationError, app_session_hint,
};
use crate::gateway::{TurnRecord, protocol::APP_PROTOCOL_VERSION};
use helpers::*;

impl AppApplication {
    pub(super) async fn session_view_owned(
        &self,
        session_id: String,
        page: AppSessionViewPage,
    ) -> Result<Value, GatewayApplicationError> {
        if is_child_session(&session_id) {
            return self.child_session_view(session_id, page).await;
        }
        self.refresh_baseline_projection(session_id.clone()).await?;
        let snapshot::Snapshot {
            mut session,
            message_page,
            latest_with_progress,
            artifacts,
            context_records,
            event_cursor,
            automation_targets,
        } = snapshot::read(self, session_id.clone(), page).await?;
        let context_session = session.clone();
        let latest = latest_with_progress.as_ref().map(|(turn, _)| turn);
        let active = latest.filter(|turn| active_state(&turn.state));
        let ((), branch, context, subsessions, work_streams) = tokio::try_join!(
            self.load_session_skills(&mut session),
            self.session_branch(&context_session),
            self.project_context(context_session.clone(), context_records),
            async { Ok::<_, GatewayApplicationError>(self.parent_subsessions(&session_id).await) },
            self.session_work_streams(&context_session, active.map(|turn| turn.id.clone())),
        )?;
        let messages = message_page.view;
        let usage = serde_json::to_value(&context.usage).map_err(json_error)?;
        let latest_message = messages.messages.last();
        let latest_turn_view = turn_projection::project_latest(
            latest_with_progress.as_ref(),
            &session.id,
            latest_message,
        )?;
        let active_turn_view = active.and(latest_turn_view.as_ref()).cloned();
        let next_cursor = butler_core::json::saturating_u64(messages.next_cursor);
        let first_cursor = messages.messages.first().map(|message| message.cursor);
        let mut view = Map::new();
        insert_session_identity(&mut view, &session, view_status(latest));
        insert_turns(
            &mut view,
            active_turn_view.as_ref(),
            latest_turn_view.as_ref(),
        )?;
        view.insert(
            "messages".into(),
            serde_json::to_value(&messages.messages).map_err(json_error)?,
        );
        insert_message_window(&mut view, next_cursor, first_cursor, message_page.has_more);
        copy(&mut view, "workers", &subsessions);
        copy(&mut view, "steward_children", &subsessions);
        view.insert("work_streams".into(), work_streams);
        view.insert("branch".into(), branch);
        view.insert("skills_used".into(), json!(session.skills_used));

        view.insert("automations".into(), automation_targets);
        view.insert(
            "artifacts".into(),
            serde_json::to_value(artifacts).map_err(json_error)?,
        );
        view.insert("context".into(), context.view);
        view.insert("usage".into(), usage);
        view.insert("errors".into(), json!(safe_errors(&messages.messages)));
        view.insert(
            "cursors".into(),
            json!({"messages":next_cursor,"events":event_cursor}),
        );
        insert_timestamps(
            &mut view,
            &self.dependencies.identity_clock.now_iso(),
            &session.updated_at,
            latest,
            latest_message,
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
        self.refresh_baseline_projection(session_id.clone()).await?;
        let session = self.get_session(session_id.clone()).await?;
        let branch_info = self.session_branch(&session).await?;
        let messages = self.message_page(session_id.clone(), 0.0, 200).await?;
        let latest = self.latest_session_turn(session_id.clone()).await?;
        let artifacts = self.artifact_page(session_id.clone()).await?;
        let context_details = self.context_details_owned(session_id.clone()).await?.view;
        let subsessions = self.parent_subsessions(&session_id).await;
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
        steward_children::complete_view_turns(&mut view);
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
        let updated = child_updated_at(&projection).ok_or(GatewayApplicationError::internal())?;
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
        let mut latest = projection
            .get("latest_turn")
            .cloned()
            .unwrap_or(Value::Null);
        steward_children::complete_turn_value(&mut latest);
        let updated = child_updated_at(&projection).ok_or(GatewayApplicationError::internal())?;
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

    /// The session's steward and worker children; empty (with a diagnostic)
    /// when they cannot be read, so the rest of the view still renders.
    async fn parent_subsessions(&self, session_id: &str) -> Value {
        let projection = self
            .dependencies
            .subsessions
            .projection(app_session_hint(session_id), None)
            .await;
        let mut projection = projection.unwrap_or_else(|error| {
            eprintln!(
                "[gateway] session view without subsessions: {error} cause={:?}",
                std::error::Error::source(&error).map(ToString::to_string)
            );
            json!({"workers": [], "steward_children": []})
        });
        let now =
            butler_core::js_date::parse_iso_millis(&self.dependencies.identity_clock.now_iso())
                .unwrap_or_default();
        steward_children::complete(&mut projection, now);
        projection
    }

    /// The benchmark reference retains the pre-CQRS request-time replay.
    pub(super) async fn refresh_baseline_projection(
        &self,
        session_id: String,
    ) -> Result<(), GatewayApplicationError> {
        if super::storage::metrics::baseline() {
            self.projection.refresh(session_id).await?;
        }
        Ok(())
    }

    async fn latest_event_cursor_owned(&self) -> Result<u64, GatewayApplicationError> {
        self.storage
            .read(super::events::latest)
            .await
            .map_err(super::app_error)
    }

    async fn session_branch(
        &self,
        session: &super::AppSessionSummary,
    ) -> Result<Value, GatewayApplicationError> {
        let project_workspace_path = self
            .project_workspace_path(session.project_id.clone())
            .await?;
        self.dependencies
            .session_workspaces
            .branch_info(
                AppSessionBranchQuery {
                    runtime_session_id: session.session_hint.clone(),
                    project_workspace_path,
                },
                tokio_util::sync::CancellationToken::new(),
            )
            .await
    }
    async fn session_work_streams(
        &self,
        session: &super::AppSessionSummary,
        current_turn_id: Option<String>,
    ) -> Result<Value, GatewayApplicationError> {
        self.dependencies
            .work_streams
            .list_active(AppWorkStreamQuery {
                app_session_id: session.id.clone(),
                runtime_session_id: session.session_hint.clone(),
                current_turn_id,
            })
            .await
    }

    pub(super) async fn latest_session_turn(
        &self,
        session_id: String,
    ) -> Result<Option<TurnRecord>, GatewayApplicationError> {
        self.storage
            .read(move |db| super::read_model::latest_turn(db, &session_id))
            .await
            .map_err(super::app_error)
    }
}
