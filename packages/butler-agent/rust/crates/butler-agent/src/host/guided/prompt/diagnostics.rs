//! Content-free digests of the exact bounded material sent to the provider.
use super::GuidedTextState;
use butler_turn::btcc::{ContextDocumentRead, GuidedInvocation, TurnRecord, UsageAttribution};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Default)]
pub(super) struct Sections {
    text: Vec<String>,
    digests: Vec<Value>,
}

impl Sections {
    pub(super) fn push(&mut self, id: &str, text: String) {
        self.digests.push(digest(id, &text));
        self.text.push(text);
    }

    pub(super) fn documents(
        &mut self,
        documents: &super::documents::DocumentProjection,
        stage: Option<super::documents::Stage>,
    ) {
        if (stage.is_none() || stage == Some(super::documents::Stage::Stable))
            && !documents.project_instructions.is_empty()
        {
            self.push(
                "project-instructions",
                documents.project_instructions.clone(),
            );
        }
        for section in documents
            .sections
            .iter()
            .filter(|section| stage.is_none_or(|stage| section.stage == stage))
        {
            self.push(&section.id, section.text.clone());
        }
    }

    pub(super) fn current_request(&mut self, turn: &TurnRecord) {
        self.push(
            "current-request",
            format!(
                "{}\n{}",
                match trigger(turn) {
                    "steward-result" => "## Delegated result\nSteward:",
                    "worker-result" => "## Delegated result\nWorker:",
                    _ => "## Current request",
                },
                turn.original_message
            ),
        );
    }

    pub(super) fn finish(self) -> (String, Value) {
        (self.text.join("\n\n"), Value::Array(self.digests))
    }
}

fn digest(id: &str, text: &str) -> Value {
    if matches!(
        id,
        "current-request"
            | "scope"
            | "recent-conversation"
            | "inbound-message"
            | "attachments"
            | "current-attachments"
            | "project-sources"
            | "branch-seed"
            | "session-references"
    ) {
        json!({"id":id,"bytes":text.len()})
    } else {
        json!({"id": id, "bytes": text.len(), "sha256": hash(text)})
    }
}

fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

pub(super) fn instruction_components(documents: &[ContextDocumentRead]) -> Value {
    let component = |ids: &[&str]| {
        hash(
            &documents
                .iter()
                .filter(|document| ids.contains(&document.source_id.as_str()))
                .map(|document| butler_core::public_text::trim_js_whitespace(&document.content))
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n"),
        )
    };
    json!({
        "persona": component(&["active-persona-reminder", "personalization-profile", "profile-projection", "turn-personalization-profile"]),
        "onboarding": component(&["first-chat-onboarding"]),
        "reminders": component(&["active-persona-reminder"]),
    })
}

pub(super) fn trigger(turn: &TurnRecord) -> &'static str {
    if turn
        .context
        .get("subsessionResult")
        .is_some_and(Value::is_object)
    {
        "steward-result"
    } else if turn
        .original_message_id
        .starts_with("worker-result-message:")
    {
        "worker-result"
    } else if turn.wake_identity.is_some() {
        "authorized-wake"
    } else if turn.suspension == Some(butler_turn::btcc::SuspensionReason::WaitingForWorker) {
        "worker-result"
    } else if turn.authority_continuation.is_some() {
        "authority-resume"
    } else {
        "user"
    }
}

pub(super) fn request_usage(
    turn: &TurnRecord,
    state: &GuidedTextState,
    invocation: GuidedInvocation<'_>,
    sections: Value,
    prompt: &str,
    components: Value,
) -> UsageAttribution {
    let mut diagnostics =
        serde_json::json!({"sourcePromptBytes": prompt.len(), "trigger": trigger(turn)});
    diagnostics["inputSections"] = sections;
    diagnostics["instructionComponents"] = components;
    UsageAttribution {
        prompt_diagnostics: Some(diagnostics),
        session_kind: Some(
            if state.phase.execution_policy.role.as_str() == "butler" {
                "parent"
            } else {
                "delegated"
            }
            .into(),
        ),
        turn_id: turn.turn_id.clone(),
        phase: state.phase.phase.as_str().into(),
        reasoning_effort: Some(invocation.model_execution.selected_reasoning_effort()),
        round_index: None,
    }
}
