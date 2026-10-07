//! Later answers enter the existing authenticated message queue with a stable id.
use super::{AppApplication, GatewayApplicationError};
use crate::gateway::{GatewayApplication, MessageSendRequest, SendMessageCommand};
use serde_json::json;

pub(super) async fn send(
    app: &AppApplication,
    session: &str,
    request_ref: &str,
    input: &str,
) -> Result<(), GatewayApplicationError> {
    app.send_message(SendMessageCommand {
        chat_id: session.into(),
        request: MessageSendRequest {
            expected_project_id: None,
            content_parts: None,
            chat_id: Some(json!(session)),
            text: Some(json!(format!(
                "Answers to your deferred questions:\n{input}"
            ))),
            client_message_id: Some(json!(format!("question-followup-{request_ref}"))),
            attachments: None,
            model: None,
            reasoning_effort: None,
            access_mode: None,
            plan_mode: None,
            subsession_result: None,
        },
    })
    .await?;
    app.dependencies
        .authority_handoff
        .settle_question_followup(request_ref.into())
        .await?;
    Ok(())
}

impl AppApplication {
    pub(super) fn authority_decide_future(
        &self,
        input: super::AppAuthorityDecisionInput,
    ) -> super::ApplicationFuture<super::AppAuthorityDecision> {
        let app = self.clone_handle();
        Box::pin(async move { app.authority_decide_owned(input).await })
    }

    pub(super) async fn authority_decide_owned(
        &self,
        input: super::AppAuthorityDecisionInput,
    ) -> Result<super::AppAuthorityDecision, GatewayApplicationError> {
        let question = input.action == "answer";
        let session = self.owner_chat(input.owner_session_id.clone()).await?;
        let result = self.dependencies.authority_handoff.decide(input).await?;
        if let Some(followup) = &result.question_followup {
            super::question_followup::send(self, &session, &result.request_ref, followup).await?;
        }
        if question {
            self.publish_gateway_event(
                "question.answered",
                serde_json::json!({"session_id":session,"request_ref":result.request_ref})
                    .as_object()
                    .cloned()
                    .ok_or_else(GatewayApplicationError::internal)?,
            )
            .await?;
        }
        Ok(result)
    }
}
