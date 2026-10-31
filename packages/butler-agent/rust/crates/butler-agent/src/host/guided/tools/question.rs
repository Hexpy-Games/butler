use super::GuidedTools;
use butler_core::json::JsonDocument;
use butler_core::tool_protocol::ToolName;
use butler_turn::btcc::GuidedInvocation;
use butler_turn::btcc::{
    AuthorityAdmissionResult, AuthorityExecutionInput, ModelRoundToolCall, QuestionBinding,
    ToolExecutionError, UserQuestions,
};
use serde_json::json;

pub(super) async fn execute(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    let (questions, wait) = match parse(call) {
        Ok(input) => input,
        Err(message) => {
            return encode(
                &json!({"ok":false,"error":{"code":"invalid_arguments","message":message}}),
            );
        }
    };
    if owner.unattended() {
        return encode(&super::turn_guard::unattended_question());
    }
    let admitted = owner
        .authority
        .ask_user_with_wait(
            QuestionBinding {
                owner_session_id: owner.binding.owner_session_id.clone(),
                source_session_id: owner.binding.source_session_id.clone(),
                turn_id: owner.binding.turn_id.clone(),
                call_id: call_id.into(),
                model_ref: owner.binding.model_ref.clone(),
                reasoning_effort: owner.binding.reasoning_effort.clone(),
            },
            questions,
            wait,
        )
        .await
        .map_err(|error| ToolExecutionError::Integrity(error.into()))?;
    let request_ref = match admitted {
        AuthorityAdmissionResult::Pending { request_ref, .. } => {
            return encode(&json!({"ok":true,"authority_pending":true,"request_ref":request_ref}));
        }
        AuthorityAdmissionResult::Modified { request_ref } => request_ref,
        _ => return encode(&json!({"ok":false,"status":"cancelled"})),
    };
    if !wait {
        return encode(
            &json!({"ok":true,"open":true,"ask_id":format!("question:{request_ref}"),"message":"The question is now an open card the user can answer any time. Finish your reply without the answer and without repeating the question; its answer will arrive as a later message."}),
        );
    }
    let execution = owner
        .authority
        .execution(AuthorityExecutionInput {
            owner_session_id: owner.binding.owner_session_id.clone(),
            request_ref,
            source_session_id: Some(owner.binding.source_session_id.clone()),
            client_message_id: None,
            turn_id: owner.binding.turn_id.clone(),
        })
        .await
        .map_err(|error| ToolExecutionError::Integrity(error.into()))?;
    let response = execution
        .question_response()
        .map_err(|error| ToolExecutionError::Integrity(error.into()))?;
    encode(&json!({"ok":true,"response":response}))
}
fn parse(call: &ModelRoundToolCall) -> Result<(UserQuestions, bool), String> {
    const SHAPE: &str = "ask_user requires 1–4 questions with unique ids, eyebrow, title, kind single/multi/text and allow_custom. single/multi take 2–6 options with unique ids, labels and kind; text takes no options. wait is an optional boolean. No icon field.";
    let mut arguments = call.arguments.clone();
    let wait = match arguments.remove("wait") {
        None => true,
        Some(serde_json::Value::Bool(wait)) => wait,
        Some(_) => return Err(SHAPE.into()),
    };
    let questions =
        serde_json::from_value::<UserQuestions>(json!(arguments)).map_err(|_| SHAPE.to_owned())?;
    questions
        .validate()
        .map_err(|reason| format!("{SHAPE} {reason}"))?;
    Ok((questions.normalized(), wait))
}

fn encode(value: &serde_json::Value) -> Result<JsonDocument, ToolExecutionError> {
    JsonDocument::from_value(value).map_err(|error| {
        ToolExecutionError::Integrity(butler_turn::btcc::BtccError::relayed(
            "guided_tool_result_invalid",
            error.to_string(),
        ))
    })
}

pub(super) async fn dispatch(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    super::dispatch::steward_gate::check(owner, call).await?;
    if matches!(
        ToolName::parse(&call.name),
        Some(ToolName::CanonRead | ToolName::CanonPropose | ToolName::CanonQueue)
    ) {
        return super::canon::execute(owner, call, call_id).await;
    }
    if call.name == ToolName::ProjectArtifacts {
        return super::project_artifacts::execute(owner, invocation, call).await;
    }
    if call.name == ToolName::ResolveAsk {
        return super::resolve_ask::execute(owner, invocation, call).await;
    }
    if call.name == ToolName::AskUser {
        return execute(owner, call, call_id).await;
    }
    super::dispatch::execute(owner, invocation, call, call_id).await
}
