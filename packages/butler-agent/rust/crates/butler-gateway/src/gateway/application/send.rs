//! Message admission, durable reservation, claim, and native enqueue flow.

use rusqlite::params;

use super::*;
use super::{
    admission_identity::{input_digest, serialize_optional, stable_client_id},
    queue::QueueReservation,
    service::assert_scope,
};
use crate::gateway::MessageContentPart;
use crate::gateway::application::storage::AppStorageCode;
use butler_turn::btcc::ControlResolution;

pub(super) struct ResolvedAppAdmission {
    pub text: String,
    pub controls: ControlResolution,
}

impl AppApplication {
    pub(super) async fn send(
        &self,
        command: SendMessageCommand,
    ) -> Result<MessageSendResult, GatewayApplicationError> {
        self.send_with_attachment_source(command, None).await
    }

    pub(super) async fn send_with_reused_attachments(
        &self,
        command: SendMessageCommand,
        source_user_message_id: String,
    ) -> Result<MessageSendResult, GatewayApplicationError> {
        self.send_with_attachment_source(command, Some(source_user_message_id))
            .await
    }

    async fn send_with_attachment_source(
        &self,
        command: SendMessageCommand,
        reused_from_message_id: Option<String>,
    ) -> Result<MessageSendResult, GatewayApplicationError> {
        self.recover_expired().await?;
        let chat_id = command.chat_id.clone();
        let request = command.request.clone();
        let settings_facts = self.dependencies.settings_facts.snapshot()?;
        let client_id = stable_client_id(
            request.client_message_id.as_ref(),
            &*self.dependencies.identity_clock,
        )?;
        let inspect_chat = chat_id.clone();
        let inspect_client = client_id.clone();
        let inspect_request = request.clone();
        let inspect_reused_from = reused_from_message_id;
        let inspected = self
            .storage
            .execute(move |db| {
                admission::inspect_with_attachment_source(
                    db,
                    &inspect_chat,
                    &inspect_client,
                    &inspect_request,
                    inspect_reused_from.as_deref(),
                )
            })
            .await
            .map_err(app_error)?;
        if let Some(replay) = inspected.replay.as_ref() {
            if !replay.matches(&request, &inspected.prepared)? {
                return Err(public(
                    409,
                    "queued_message_identity_conflict",
                    "This client message id was already accepted with different input.",
                ));
            }
            let controls_json = replay.controls_json.as_deref().ok_or_else(|| {
                public(
                    500,
                    "turn_control_resolution_invalid",
                    "Turn controls are unavailable.",
                )
            })?;
            let controls = settings::resolution_from_persisted(controls_json).map_err(app_error)?;
            return self
                .dispatch(
                    &chat_id,
                    &client_id,
                    ResolvedAppAdmission {
                        text: inspected.prepared.text,
                        controls,
                    },
                )
                .await;
        }
        let mut prepared = inspected.prepared;
        let has_project_refs = request.content_parts.as_ref().is_some_and(|content| {
            content
                .parts
                .iter()
                .any(|part| matches!(part, MessageContentPart::ProjectSourceRef { .. }))
        });
        let sources = self
            .resolve_project_sources(&inspected.chat, request.content_parts.as_ref())
            .await?;
        if has_project_refs && sources.as_array().is_none_or(Vec::is_empty) {
            return Err(public(
                503,
                "project_sources_unavailable",
                "Project sources are unavailable.",
            ));
        }
        prepared.project_sources = sources;
        let digest = input_digest(&request, &prepared)?;
        let queued_id = format!("queued-{}", self.dependencies.identity_clock.new_uuid());
        let created_at = self.dependencies.identity_clock.now_iso();
        let reservation_base = QueueReservation {
            id: queued_id.clone(),
            chat_id: chat_id.clone(),
            text: prepared.text.clone(),
            client_message_id: client_id.clone(),
            input_identity_digest: digest,
            control_resolution_json: String::new(),
            controls_json: String::new(),
            attachments_json: stringify(&prepared.attachments)?,
            content_parts_json: serialize_optional(request.content_parts.as_ref())?,
            project_source_refs_json: stringify(&prepared.project_sources)?,
            created_at: created_at.clone(),
        };
        let sources = prepared.project_sources.clone();
        let expected = request.expected_project_id.clone();
        let request_for_resolution = request.clone();
        let subscribers = self.subscribers.clone();
        let (inserted, resolved) = self
            .storage
            .execute(move |connection| {
                let transaction = connection.transaction().map_err(AppStorageError::sqlite)?;
                assert_scope(
                    &transaction,
                    &reservation_base.chat_id,
                    expected.as_deref(),
                    &sources,
                )?;
                if let Some(persisted) = queue::existing_control_resolution(
                    &transaction,
                    &reservation_base.chat_id,
                    &reservation_base.client_message_id,
                    &reservation_base.input_identity_digest,
                )? {
                    let resolution = settings::resolution_from_persisted(&persisted)?;
                    transaction.commit().map_err(AppStorageError::sqlite)?;
                    return Ok((false, resolution));
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
                reservation.control_resolution_json =
                    stringify(&resolved.persisted).map_err(|source| {
                        AppStorageError::new(
                            AppStorageCode::SettingsJsonFailed,
                            "Settings could not be encoded.",
                        )
                        .with_source(source)
                    })?;
                reservation.controls_json =
                    stringify(&resolved.persisted["controls"]).map_err(|source| {
                        AppStorageError::new(
                            AppStorageCode::SettingsJsonFailed,
                            "Settings could not be encoded.",
                        )
                        .with_source(source)
                    })?;
                let inserted = queue::reserve(&transaction, &reservation)?;
                transaction.commit().map_err(AppStorageError::sqlite)?;
                Ok((inserted, resolved.resolution))
            })
            .await
            .map_err(app_error)?;
        let prepared = ResolvedAppAdmission {
            text: prepared.text,
            controls: resolved,
        };
        if inserted {
            let visual = self
                .admit_visual_localized(VisualAdmissionRequest {
                    model_ref: prepared.controls.model.clone(),
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
        self.dispatch(&chat_id, &client_id, prepared).await
    }

    async fn dispatch(
        &self,
        chat_id: &str,
        client_id: &str,
        prepared: ResolvedAppAdmission,
    ) -> Result<MessageSendResult, GatewayApplicationError> {
        let Some(order) = self.admit_instruction(chat_id, client_id).await? else {
            self.queue_wake.chat(chat_id.to_owned()).await?;
            return self.queued_result(chat_id, client_id).await;
        };
        let claim_id = self.dependencies.identity_clock.new_uuid();
        let now = self.dependencies.identity_clock.now_iso();
        let lease = self
            .dependencies
            .identity_clock
            .iso_after_millis(queue::SESSION_QUEUE_LEASE_MILLIS as u64);
        let chat = chat_id.to_owned();
        let client = client_id.to_owned();
        let owner = self.queue_owner.clone();
        let subscribers = self.subscribers.clone();
        let claim = self.storage.execute(move |connection| {
            let id = connection.query_row("SELECT id FROM session_queued_messages WHERE chat_id=?1 AND client_message_id=?2",
                params![chat,client], |row| row.get::<_,String>(0)).map_err(AppStorageError::sqlite)?;
            queue::claim(
                connection,
                &queue::QueueClaim {
                    queued_message_id: id,
                    chat_id: chat,
                    claim_id,
                    claim_owner: owner,
                    lease_expires_at: lease,
                },
                order,
                &now,
                &subscribers,
            )
        }).await.map_err(app_error)?;
        let Some(claim) = claim else {
            // Every handle (request handles too) can wake the dispatcher, so a
            // message queued behind others is dispatched in order even when no
            // turn is running to wake it.
            self.queue_wake.chat(chat_id.to_owned()).await?;
            return self.queued_result(chat_id, client_id).await;
        };
        self.start_turn(claim, prepared).await
    }
}
