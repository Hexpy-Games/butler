//! Source answer selection and summary seed preparation.

use tokio_util::sync::CancellationToken;

use super::{
    AppSessionBranchDestination, AppSessionBranchRequest, AppSessionBranchSeed,
    store::{self, BranchRow},
};
use crate::gateway::{
    AppStartTopicConversationRequest as StartRequest, GatewayApplicationError,
    application::AppApplication,
};

const SUMMARY_MODEL_FALLBACK: &str = crate::models::DEFAULT_MODEL_REF;

impl AppApplication {
    pub(super) async fn resolve_request(
        &self,
        input: StartRequest,
    ) -> Result<(AppSessionBranchRequest, String, Option<BranchRow>), GatewayApplicationError> {
        if input.request_id.trim().is_empty() {
            return Err(public(
                400,
                "session_branch_request_identity_required",
                "A branch request identity is required.",
            ));
        }
        if input.title.trim().is_empty() {
            return Err(public(
                400,
                "branch_request_invalid",
                "대화 생성 요청을 확인해 주세요.",
            ));
        }
        let destination = match input.destination.as_str() {
            "chat" => AppSessionBranchDestination::Chat,
            "project" => {
                let Some(project_id) = input
                    .project_id
                    .as_deref()
                    .filter(|value| !value.is_empty())
                else {
                    return Err(public(
                        400,
                        "branch_request_invalid",
                        "대화 생성 요청을 확인해 주세요.",
                    ));
                };
                AppSessionBranchDestination::Project {
                    project_id: project_id.to_owned(),
                }
            }
            "new_project" => AppSessionBranchDestination::NewProject {
                name: input.title.clone(),
            },
            _ => {
                return Err(public(
                    400,
                    "branch_request_invalid",
                    "대화 생성 요청을 확인해 주세요.",
                ));
            }
        };
        let follow_up = match input.follow_up {
            None => None,
            Some(serde_json::Value::String(value)) => Some(value),
            Some(_) => {
                return Err(public(
                    400,
                    "branch_request_invalid",
                    "대화 생성 요청을 확인해 주세요.",
                ));
            }
        };

        let request_id = input.request_id;
        let existing = self
            .storage
            .execute({
                let request_id = request_id.clone();
                move |db| store::row(db, &request_id)
            })
            .await
            .map_err(super::super::app_error)?;
        let prior = existing
            .as_ref()
            .map(store::saved_request)
            .transpose()
            .map_err(super::super::app_error)?;
        let requested_source = input
            .source_session_id
            .or_else(|| {
                prior
                    .as_ref()
                    .map(|request| request.source_session_id.clone())
            })
            .or(input.current_session_id)
            .ok_or_else(|| public(400, "branch_source_required", "출처 대화가 필요합니다."))?;
        let canonical = self
            .dependencies
            .branch_conversations
            .resolve_app_session(requested_source.clone())
            .await?;
        let source_session_id = self
            .storage
            .execute({
                let requested_source = requested_source.clone();
                move |db| store::resolve_source_session(db, &requested_source, canonical.as_ref())
            })
            .await
            .map_err(super::super::app_error)?
            .ok_or_else(|| {
                public(
                    404,
                    "branch_source_unavailable",
                    "출처 대화를 확인해 주세요.",
                )
            })?;
        let source_message_was_omitted = input.source_message_id.is_none();
        let requested_message = input.source_message_id.or_else(|| {
            prior
                .as_ref()
                .map(|request| request.source_message_id.clone())
        });
        let saved_source = prior
            .as_ref()
            .filter(|saved| saved.source_session_id == source_session_id)
            .filter(|_| existing.is_some() && source_message_was_omitted);
        let source_message_id = if let Some(saved) = saved_source {
            saved.source_message_id.clone()
        } else {
            self.resolve_answer(&source_session_id, requested_message.as_deref())
                .await?
        };
        let request = AppSessionBranchRequest {
            request_id,
            source_session_id,
            source_message_id,
            title: input.title,
            follow_up,
            destination,
        };
        let digest = self
            .storage
            .execute({
                let request = request.clone();
                move |_| store::input_digest(&request)
            })
            .await
            .map_err(super::super::app_error)?;
        Ok((request, digest, existing))
    }

    async fn resolve_answer(
        &self,
        source_session_id: &str,
        requested_message_id: Option<&str>,
    ) -> Result<String, GatewayApplicationError> {
        let app_message = self
            .storage
            .execute({
                let session = source_session_id.to_owned();
                let requested = requested_message_id.map(str::to_owned);
                move |db| store::selected_message(db, &session, requested.as_deref())
            })
            .await
            .map_err(super::super::app_error)?;
        if let Some(message) = app_message {
            if message.role != "assistant"
                || !matches!(message.status.as_str(), "delivered" | "completed" | "sent")
            {
                return Err(source_answer_unavailable());
            }
            return Ok(message.id);
        }
        let Some(requested) = requested_message_id else {
            return Err(source_answer_unavailable());
        };
        let canonical = self
            .dependencies
            .branch_conversations
            .answer(requested.to_owned())
            .await?
            .ok_or_else(source_answer_unavailable)?;
        let expected = self
            .dependencies
            .branch_conversations
            .resolve_app_session(super::super::app_session_hint(source_session_id))
            .await?
            .map(|(session, _)| session);
        if expected
            .as_deref()
            .is_some_and(|session| session != canonical.session_id)
        {
            return Err(source_answer_unavailable());
        }
        self.storage
            .execute({
                let source_session_id = source_session_id.to_owned();
                move |db| {
                    let row =
                        store::unique_message_for_turn(db, &source_session_id, &canonical.turn_id)?;
                    Ok(row.map(|message| message.id))
                }
            })
            .await
            .map_err(super::super::app_error)?
            .ok_or_else(source_answer_unavailable)
    }

    pub(super) async fn prepare_seed(
        &self,
        request: &AppSessionBranchRequest,
        server_shutdown: &CancellationToken,
        owner_shutdown: &CancellationToken,
    ) -> Result<AppSessionBranchSeed, GatewayApplicationError> {
        let message = self
            .storage
            .execute({
                let session = request.source_session_id.clone();
                let id = request.source_message_id.clone();
                move |db| store::message_by_id(db, &session, &id)
            })
            .await
            .map_err(super::super::app_error)?
            .ok_or_else(source_answer_unavailable)?;
        let mut canonical = None;
        if let Some(message_id) = message.conversation_message_id.as_deref()
            && let Some(answer) = self
                .dependencies
                .branch_conversations
                .answer(message_id.to_owned())
                .await?
            && Some(answer.session_id.as_str()) == message.conversation_session_id.as_deref()
        {
            canonical = Some(answer);
        }
        let canonical_text = if let Some(answer) = &canonical {
            self.dependencies
                .branch_conversations
                .context(answer.session_id.clone(), answer.message_id.clone())
                .await?
        } else {
            None
        };
        let text = match canonical_text {
            Some(text) => text,
            None => self
                .storage
                .execute(move |db| store::app_context(db, &message))
                .await
                .map_err(super::super::app_error)?,
        };
        let model_ref = self
            .dependencies
            .settings_facts
            .snapshot()?
            .config_default_model
            .clone()
            .filter(|model| !model.trim().is_empty())
            .unwrap_or_else(|| SUMMARY_MODEL_FALLBACK.to_owned());
        let cancellation = CancellationToken::new();
        let summary_input = crate::gateway::AppBranchSummaryInput { text, model_ref };
        let result = tokio::select! {
            result = self.dependencies.branch_summarizer.summarize(summary_input, cancellation.clone()) => result?,
            () = server_shutdown.cancelled() => { cancellation.cancel(); return Err(cancelled()); }
            () = owner_shutdown.cancelled() => { cancellation.cancel(); return Err(cancelled()); }
        };
        let summary_text = crate::public_text::trim_js_whitespace(&result.text).to_owned();
        if summary_text.is_empty() {
            return Err(public(
                502,
                "branch_summary_empty",
                "새 대화의 맥락 요약을 만들지 못했습니다.",
            ));
        }
        Ok(AppSessionBranchSeed {
            summary: summary_text,
            source_session_id: request.source_session_id.clone(),
            source_message_id: request.source_message_id.clone(),
            canonical_session_id: canonical.as_ref().map(|answer| answer.session_id.clone()),
            canonical_message_id: canonical.as_ref().map(|answer| answer.message_id.clone()),
            source_through_message_id: request.source_message_id.clone(),
            excerpt_truncated: result.excerpt_truncated,
        })
    }
}

fn source_answer_unavailable() -> GatewayApplicationError {
    public(
        404,
        "branch_source_unavailable",
        "분리할 완료된 답변이 없습니다.",
    )
}

fn cancelled() -> GatewayApplicationError {
    public(409, "branch_cancelled", "새 대화 만들기가 취소되었습니다.")
}

fn public(status: u16, code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.to_owned(),
        message: message.to_owned(),
    }
}
