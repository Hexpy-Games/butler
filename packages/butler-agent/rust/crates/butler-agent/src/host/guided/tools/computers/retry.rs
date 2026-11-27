use super::{
    BtccError, GuidedTools, JsonDocument, ToolExecutionError, ToolName, already_applied, apply,
    card, card_mismatch, encoded, failure,
};
use butler_turn::btcc::{
    AuthorityExecutionInput, AuthorityStoredExecution, GuidedInvocation, ModelRoundToolCall,
    RequestOutcome, UserQuestion, UserQuestionAnswer, UserQuestionResponse, UserQuestions,
    question_slot_request_ref,
};
use serde_json::{Value, json};

fn slot(attempt: usize) -> String {
    if attempt == 0 {
        "connection".into()
    } else {
        format!("connection.{attempt}")
    }
}

pub(super) async fn offer(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    call_id: &str,
    name: &str,
    attempt: usize,
    result: JsonDocument,
) -> Result<JsonDocument, ToolExecutionError> {
    let output = read(&result)?;
    if let Some(code) = output["error"]["code"]
        .as_str()
        .filter(|code| gateway_message(code).is_some())
    {
        let questions = card::connection(owner, code, name, &call.arguments);
        let admitted = super::super::question::admit(
            owner,
            call_id,
            questions,
            true,
            Some(call.name.clone()),
            Some(&slot(attempt)),
        )
        .await?;
        if read(&admitted)?["authority_pending"] == true {
            return Ok(admitted);
        }
    }
    if attempt > 0 {
        return with_retry(output, "answered");
    }
    Ok(result)
}

async fn current(
    owner: &GuidedTools,
    call_id: &str,
) -> Result<Option<(usize, String, AuthorityStoredExecution)>, ToolExecutionError> {
    let mut last_applied = None;
    let mut n = 0;
    loop {
        let request_ref = question_slot_request_ref(&owner.binding.turn_id, call_id, &slot(n));
        let execution = owner
            .authority
            .execution(AuthorityExecutionInput {
                owner_session_id: owner.binding.owner_session_id.clone(),
                request_ref: request_ref.clone(),
                source_session_id: Some(owner.binding.source_session_id.clone()),
                client_message_id: None,
                turn_id: owner.binding.turn_id.clone(),
            })
            .await;
        match execution {
            Ok(execution) if execution.outcome == RequestOutcome::Applied => {
                last_applied = Some((n, request_ref, execution));
                n += 1;
            }
            Ok(execution) => return Ok(Some((n, request_ref, execution))),
            Err(error) if error.code() == "authority_request_not_found" => return Ok(last_applied),
            Err(error) => return Err(ToolExecutionError::Integrity(error.into())),
        }
    }
}

pub(super) async fn resume(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    call_id: &str,
    first: &AuthorityStoredExecution,
) -> Result<JsonDocument, ToolExecutionError> {
    let (n, request_ref, execution) = match current(owner, call_id).await {
        Ok(Some(slot)) if slot.2.outcome != RequestOutcome::Applied => slot,
        Ok(_) => return already_applied(),
        Err(ToolExecutionError::Integrity(error)) => {
            return encoded(&failure(error.code(), error.message()));
        }
    };
    let Ok(questions) = serde_json::from_value::<UserQuestions>(execution.normalized_input.clone())
    else {
        return card_mismatch();
    };
    let Some((fields, original)) = connection_fields(&questions) else {
        return card_mismatch();
    };
    let UserQuestionResponse::Answered { answers } = response(&execution)? else {
        return with_retry(original, "deferred");
    };
    let password_setup = answers.iter().any(|answer| {
        answer.id == fields[1].id
            && answer
                .selected
                .first()
                .is_some_and(|id| id == "password_setup")
    });
    let [port, key_file] = fields.map(|question| answer_value(question, &answers));
    if port.is_none() && key_file.is_none() && !password_setup {
        return with_retry(original, "cancelled");
    }
    let port = match port.map(card::parse_port) {
        Some(None) => {
            return with_retry(
                failure("computer_port_invalid", "Enter a valid SSH port."),
                "answered",
            );
        }
        port => port.flatten(),
    };
    let UserQuestionResponse::Answered { answers } = response(first)? else {
        return card_mismatch();
    };
    let values = serde_json::from_value::<UserQuestions>(first.normalized_input.clone())
        .ok()
        .and_then(|questions| card::answers(ToolName::ComputerAdd, &questions, &answers));
    let Some((None, mut values)) = values.filter(|(_, values)| values.len() == 4) else {
        return card_mismatch();
    };
    let Some(name) = values["name"].as_str().map(str::to_owned) else {
        return card_mismatch();
    };
    if let Some(port) = port {
        values.insert("port".into(), json!(port));
    }
    if password_setup {
        values.insert("managed_key".into(), json!(true));
        values.insert("password_ref".into(), json!(request_ref));
    } else if let Some(key_file) = key_file {
        values.insert("key_file".into(), json!(key_file));
    }
    let result = apply::claimed(
        owner,
        invocation.cancellation,
        ToolName::ComputerAdd,
        request_ref,
        None,
        values,
    )
    .await?;
    offer(owner, call, call_id, &name, n + 1, result).await
}

fn connection_fields(questions: &UserQuestions) -> Option<([&UserQuestion; 2], Value)> {
    let [port, key_file] = questions.questions.as_slice() else {
        return None;
    };
    let (prefix, field) = port.id.split_once('.')?;
    let code = prefix.strip_prefix("computer_add:")?;
    let message = gateway_message(code)?;
    if field != "port" || key_file.id != format!("{prefix}.key_file") {
        return None;
    }
    Some(([port, key_file], failure(code, message)))
}

fn answer_value<'a>(
    question: &'a UserQuestion,
    answers: &'a [UserQuestionAnswer],
) -> Option<&'a str> {
    let answer = answers.iter().find(|answer| answer.id == question.id)?;
    let selected = answer.selected.first().map(String::as_str);
    if answer.skipped || matches!(selected, Some("none" | "password_setup")) {
        return None;
    }
    answer
        .custom
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            question
                .options
                .iter()
                .find(|option| selected == Some("proposed") && option.id == "proposed")
                .map(|option| option.label.as_str())
        })
}

fn gateway_message(code: &str) -> Option<&'static str> {
    match code {
        "ssh_unreachable" => Some("Could not reach this computer."),
        "ssh_auth_failed" => Some("SSH key login failed."),
        "ssh_password_wrong" => Some("Wrong password."),
        "ssh_password_not_allowed" => Some("This computer doesn't accept password sign-in."),
        "ssh_password_extra_step" => Some("This computer needs another sign-in step."),
        "ssh_key_install_failed" => Some("Couldn't install the SSH key."),
        _ => None,
    }
}

fn response(
    execution: &AuthorityStoredExecution,
) -> Result<UserQuestionResponse, ToolExecutionError> {
    execution
        .question_response()
        .map_err(|error| ToolExecutionError::Integrity(error.into()))
}

fn read(document: &JsonDocument) -> Result<Value, ToolExecutionError> {
    document.read().map_err(|error| {
        ToolExecutionError::Integrity(BtccError::relayed(
            "guided_tool_result_invalid",
            error.to_string(),
        ))
    })
}

fn with_retry(mut result: Value, status: &str) -> Result<JsonDocument, ToolExecutionError> {
    result["retry"] = json!(status);
    encoded(&result)
}
