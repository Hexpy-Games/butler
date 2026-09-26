use rusqlite::params;
use serde_json::{Value, json};
mod owner;
mod support;
use super::{
    AppApplication, AppStorageError, GatewayApplicationError, SessionQueueUpdateRequest,
    SessionQueueView, admission, admission_identity, app_error, events, queue, queue_view, service,
    settings,
};
use crate::{
    gateway::{MessageSendRequest, SessionControlState, VisualAdmissionRequest},
    public_text::trim_js_whitespace,
};
pub(in crate::gateway::application) use owner::SessionQueueMutationOwner;
use support::{
    apply_plan_binding, attachment_ids, attachment_values, authority_immutable,
    content_matches_current, content_text, has_authority, has_project_sources, identity_conflict,
    invalid_resolution_storage, json_string, json_string_storage, not_found_error,
    parse_project_sources, public_error, request_chat_id, storage_not_found, update_content,
};
impl AppApplication {
    pub(super) async fn create_session_queue_owned(
        &self,
        request: MessageSendRequest,
    ) -> Result<SessionQueueView, GatewayApplicationError> {
        let owner = self.queue_mutations.clone();
        let application = self.clone_handle();
        owner
            .run(Box::pin(async move {
                application.create_session_queue_inner(request).await
            }))
            .await
    }

    pub(super) async fn update_session_queue_owned(
        &self,
        queued_message_id: String,
        request: SessionQueueUpdateRequest,
    ) -> Result<SessionQueueView, GatewayApplicationError> {
        let owner = self.queue_mutations.clone();
        let application = self.clone_handle();
        owner
            .run(Box::pin(async move {
                application
                    .update_session_queue_inner(queued_message_id, request)
                    .await
            }))
            .await
    }

    pub(super) async fn delete_session_queue_owned(
        &self,
        queued_message_id: String,
    ) -> Result<SessionQueueView, GatewayApplicationError> {
        let owner = self.queue_mutations.clone();
        let application = self.clone_handle();
        owner
            .run(Box::pin(async move {
                application
                    .delete_session_queue_inner(queued_message_id)
                    .await
            }))
            .await
    }

    async fn create_session_queue_inner(
        &self,
        request: MessageSendRequest,
    ) -> Result<SessionQueueView, GatewayApplicationError> {
        let chat_id = request_chat_id(&request)?;
        self.recover_expired().await?;
        let settings_facts = self.dependencies.settings_facts.snapshot()?;
        let client_id = admission_identity::stable_client_id(
            request.client_message_id.as_ref(),
            &*self.dependencies.identity_clock,
        )?;
        let inspect_chat = chat_id.clone();
        let inspect_client = client_id.clone();
        let inspect_request = request.clone();
        let inspected = self
            .storage
            .execute(move |db| {
                admission::inspect(db, &inspect_chat, &inspect_client, &inspect_request)
            })
            .await
            .map_err(app_error)?;
        if let Some(replay) = inspected.replay.as_ref() {
            if !replay.matches(&request, &inspected.prepared)? {
                return Err(identity_conflict());
            }
            return self.queue_page(chat_id).await;
        }

        let mut prepared = inspected.prepared;
        let has_project_refs = has_project_sources(request.content_parts.as_ref());
        prepared.project_sources = self
            .resolve_project_sources(&inspected.chat, request.content_parts.as_ref())
            .await?;
        if has_project_refs
            && prepared
                .project_sources
                .as_array()
                .is_none_or(Vec::is_empty)
        {
            return Err(public_error(
                503,
                "project_sources_unavailable",
                "Project sources are unavailable.",
            ));
        }
        let digest = admission_identity::input_digest(&request, &prepared)?;
        let queued_id = format!("queued-{}", self.dependencies.identity_clock.new_uuid());
        let created_at = self.dependencies.identity_clock.now_iso();
        let reservation_base = queue::QueueReservation {
            id: queued_id.clone(),
            chat_id: chat_id.clone(),
            text: prepared.text.clone(),
            client_message_id: client_id.clone(),
            input_identity_digest: digest,
            control_resolution_json: String::new(),
            controls_json: String::new(),
            attachments_json: json_string(&prepared.attachments)?,
            content_parts_json: admission_identity::serialize_optional(
                request.content_parts.as_ref(),
            )?,
            project_source_refs_json: json_string(&prepared.project_sources)?,
            created_at: created_at.clone(),
        };
        let expected = request.expected_project_id.clone();
        let request_for_resolution = request.clone();
        let subscribers = self.subscribers.clone();
        let project_sources = prepared.project_sources.clone();
        let (inserted, controls) = self
            .storage
            .execute(move |db| {
                let transaction = db.transaction().map_err(AppStorageError::sqlite)?;
                service::assert_scope(
                    &transaction,
                    &reservation_base.chat_id,
                    expected.as_deref(),
                    &project_sources,
                )?;
                if let Some(persisted) = queue::existing_control_resolution(
                    &transaction,
                    &reservation_base.chat_id,
                    &reservation_base.client_message_id,
                    &reservation_base.input_identity_digest,
                )? {
                    let resolved = settings::resolution_from_persisted(&persisted)?;
                    transaction.commit().map_err(AppStorageError::sqlite)?;
                    return Ok((false, resolved));
                }
                let resolved = settings::resolve_for_message_send(
                    &transaction,
                    &subscribers,
                    &reservation_base.chat_id,
                    &request_for_resolution,
                    &settings_facts,
                    &reservation_base.created_at,
                )?;
                let mut reservation = reservation_base;
                reservation.control_resolution_json = json_string_storage(&resolved.persisted)?;
                reservation.controls_json = json_string_storage(
                    resolved
                        .persisted
                        .get("controls")
                        .ok_or_else(invalid_resolution_storage)?,
                )?;
                let inserted = queue::reserve(&transaction, &reservation)?;
                transaction.commit().map_err(AppStorageError::sqlite)?;
                Ok((inserted, resolved.resolution))
            })
            .await
            .map_err(app_error)?;

        if inserted {
            let visual = self
                .dependencies
                .admission
                .admit_visual(VisualAdmissionRequest {
                    model_ref: controls.model.clone(),
                    files: inspected.files,
                })
                .await;
            match visual {
                Ok(attachments) => {
                    self.finish_visual(&chat_id, &queued_id, attachments)
                        .await?;
                }
                Err(error) => {
                    self.fail_admission(&chat_id, &queued_id, &error).await?;
                    return Err(error);
                }
            }
        }
        self.queue_page(chat_id).await
    }

    async fn update_session_queue_inner(
        &self,
        queued_message_id: String,
        request: SessionQueueUpdateRequest,
    ) -> Result<SessionQueueView, GatewayApplicationError> {
        let row_id = queued_message_id.clone();
        let current = self
            .storage
            .execute(move |db| queue_view::mutation_row(db, &row_id))
            .await
            .map_err(app_error)?
            .ok_or_else(not_found_error)?;
        if current.state != "queued" {
            return Err(not_found_error());
        }
        if has_authority(&current.control_resolution_json) {
            return Err(authority_immutable());
        }

        let content = update_content(&current, &request)?;
        let attachment_ids = match request.attachments.as_ref() {
            Some(ids) => ids.clone(),
            None => attachment_ids(&current.attachments_json)?,
        };
        let text = content.as_ref().map(content_text).unwrap_or_else(|| {
            request
                .text
                .as_deref()
                .map(trim_js_whitespace)
                .map(str::to_owned)
                .unwrap_or_else(|| current.text.clone())
        });
        let inspect_request = MessageSendRequest {
            subsession_result: None,
            expected_project_id: None,
            content_parts: content.clone(),
            chat_id: Some(Value::String(current.chat_id.clone())),
            text: Some(Value::String(text)),
            client_message_id: None,
            attachments: Some(attachment_values(&attachment_ids)),
            model: None,
            reasoning_effort: None,
            access_mode: None,
            plan_mode: None,
        };
        let inspect_chat = current.chat_id.clone();
        let inspect_id = format!("queue-update-{}", current.id);
        let request_for_inspection = inspect_request.clone();
        let inspected = self
            .storage
            .execute(move |db| {
                admission::inspect(db, &inspect_chat, &inspect_id, &request_for_inspection)
            })
            .await
            .map_err(app_error)?;

        let settings_facts = self.dependencies.settings_facts.snapshot()?;
        let stored_controls =
            serde_json::from_str::<SessionControlState>(&current.controls_json).ok();
        let base = stored_controls.unwrap_or_else(|| SessionControlState {
            model: String::new(),
            reasoning_effort: String::new(),
            access_mode: String::new(),
            plan_mode: false,
        });
        let controls_request = MessageSendRequest {
            subsession_result: None,
            expected_project_id: None,
            content_parts: None,
            chat_id: Some(Value::String(current.chat_id.clone())),
            text: Some(Value::String(inspected.prepared.text.clone())),
            client_message_id: None,
            attachments: None,
            model: Some(Value::String(request.model.clone().unwrap_or(base.model))),
            reasoning_effort: Some(Value::String(
                request
                    .reasoning_effort
                    .clone()
                    .unwrap_or(base.reasoning_effort),
            )),
            access_mode: Some(Value::String(
                request.access_mode.clone().unwrap_or(base.access_mode),
            )),
            plan_mode: Some(Value::Bool(request.plan_mode.unwrap_or(base.plan_mode))),
        };
        let resolution_request = controls_request.clone();
        let chat_id = current.chat_id.clone();
        let created_at = self.dependencies.identity_clock.now_iso();
        let subscribers = self.subscribers.clone();
        let mut resolved = self
            .storage
            .execute(move |db| {
                settings::resolve_for_message_send(
                    db,
                    &subscribers,
                    &chat_id,
                    &resolution_request,
                    &settings_facts,
                    &created_at,
                )
            })
            .await
            .map_err(app_error)?;
        apply_plan_binding(
            &mut resolved.persisted,
            &current.control_resolution_json,
            request.plan_id.as_deref(),
        );

        let mut final_request = inspect_request;
        final_request.model = request.model.clone().map(Value::String);
        final_request.reasoning_effort = request.reasoning_effort.clone().map(Value::String);
        final_request.access_mode = request.access_mode.clone().map(Value::String);
        final_request.plan_mode = request.plan_mode.map(Value::Bool);
        let mut prepared = inspected.prepared;
        let has_project_refs = has_project_sources(content.as_ref());
        let same_sources = content_matches_current(&content, &current.content_parts_json)?;
        prepared.project_sources = if same_sources {
            parse_project_sources(current.project_source_refs_json.as_deref())?
        } else {
            self.resolve_project_sources(&inspected.chat, content.as_ref())
                .await?
        };
        if has_project_refs
            && prepared
                .project_sources
                .as_array()
                .is_none_or(Vec::is_empty)
        {
            return Err(public_error(
                503,
                "project_sources_unavailable",
                "Project sources are unavailable.",
            ));
        }
        let input_identity_digest = admission_identity::input_digest_with_plan(
            &final_request,
            &prepared,
            request.plan_id.as_deref(),
        )?;
        let visual = self
            .dependencies
            .admission
            .admit_visual(VisualAdmissionRequest {
                model_ref: resolved.resolution.model.clone(),
                files: inspected.files,
            })
            .await?;

        let now = self.dependencies.identity_clock.now_iso();
        let old_digest = current.input_identity_digest.unwrap_or_default();
        let id = current.id.clone();
        let chat_id = current.chat_id.clone();
        let storage_chat_id = chat_id.clone();
        let text = prepared.text.clone();
        let controls_json = json_string(resolved.persisted.get("controls").ok_or_else(|| {
            public_error(
                500,
                "turn_control_resolution_invalid",
                "Turn controls are unavailable.",
            )
        })?)?;
        let resolution_json = json_string(&resolved.persisted)?;
        let attachments_json = json_string(&visual)?;
        let content_json = admission_identity::serialize_optional(content.as_ref())?;
        let sources_json = json_string(&prepared.project_sources)?;
        let project_sources = prepared.project_sources.clone();
        let subscribers = self.subscribers.clone();
        self.storage
            .execute(move |db| {
                let transaction = db.transaction().map_err(AppStorageError::sqlite)?;
                let row = queue_view::mutation_row(&transaction, &id)?
                    .ok_or_else(storage_not_found)?;
                if has_authority(&row.control_resolution_json) {
                    return Err(AppStorageError::new(
                        "authority_queue_immutable",
                        "Approved command queue entries cannot be edited.",
                    ));
                }
                service::assert_scope(
                    &transaction,
                    &storage_chat_id,
                    None,
                    &project_sources,
                )?;
                let changed = transaction
                    .execute(
                        "UPDATE session_queued_messages SET text=?1,control_resolution_json=?2,controls_json=?3,attachments_json=?4,content_parts_json=?5,project_source_refs_json=?6,input_identity_digest=?7,updated_at=?8 WHERE id=?9 AND state='queued' AND COALESCE(input_identity_digest,'')=?10",
                        params![text, resolution_json, controls_json, attachments_json, content_json, sources_json, input_identity_digest, now, id, old_digest],
                    )
                    .map_err(AppStorageError::sqlite)?;
                if changed != 1 {
                    return Err(AppStorageError::new(
                        "queued_message_changed",
                        "Queued message changed. Reload it.",
                    ));
                }
                events::append(
                    &transaction,
                    &subscribers,
                    "session_queue.changed",
                    None,
                    service::map(json!({
                        "session_id": storage_chat_id,
                        "queued_message_id": id,
                        "action": "updated"
                    }))?,
                    &now,
                )?;
                transaction.commit().map_err(AppStorageError::sqlite)
            })
            .await
            .map_err(app_error)?;
        self.queue_page(chat_id).await
    }

    async fn delete_session_queue_inner(
        &self,
        queued_message_id: String,
    ) -> Result<SessionQueueView, GatewayApplicationError> {
        let id = queued_message_id;
        let now = self.dependencies.identity_clock.now_iso();
        let subscribers = self.subscribers.clone();
        let chat_id = self
            .storage
            .execute(move |db| {
                let transaction = db.transaction().map_err(AppStorageError::sqlite)?;
                let row = queue_view::mutation_row(&transaction, &id)?
                    .ok_or_else(storage_not_found)?;
                if !matches!(row.state.as_str(), "queued" | "failed") {
                    return Err(storage_not_found());
                }
                if has_authority(&row.control_resolution_json) {
                    return Err(AppStorageError::new(
                        "authority_queue_immutable",
                        "Approved command queue entries cannot be deleted.",
                    ));
                }
                let chat_id = row.chat_id.clone();
                let changed = transaction
                    .execute(
                        "UPDATE session_queued_messages SET state='deleted',updated_at=?1 WHERE id=?2 AND state IN ('queued','failed')",
                        params![now, id],
                    )
                    .map_err(AppStorageError::sqlite)?;
                if changed != 1 {
                    return Err(storage_not_found());
                }
                events::append(
                    &transaction,
                    &subscribers,
                    "session_queue.changed",
                    None,
                    service::map(json!({
                        "session_id": chat_id,
                        "queued_message_id": id,
                        "action": "deleted"
                    }))?,
                    &now,
                )?;
                transaction.commit().map_err(AppStorageError::sqlite)?;
                Ok(chat_id)
            })
            .await
            .map_err(app_error)?;
        self.queue_page(chat_id).await
    }
}
