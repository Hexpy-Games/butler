use serde_json::{Map, Value};

use super::super::ConversationRole;
use super::identity::{app_session_id, clean, clean_opt, timestamp_millis, valid_timestamp};
use super::input::{HistoricalAppProjectionRow, HistoricalTranscriptRow};

#[derive(Clone, Copy)]
pub(super) enum SourceKind {
    Transcript,
    AppProjection,
}

impl SourceKind {
    pub(super) fn text(self) -> &'static str {
        match self {
            Self::Transcript => "transcript",
            Self::AppProjection => "app_projection",
        }
    }
}

#[derive(Clone, Copy)]
pub(super) enum Provenance {
    Trusted,
    Recovered,
    Discarded,
    Ambiguous,
}

impl Provenance {
    pub(super) fn text(self) -> &'static str {
        match self {
            Self::Trusted => "trusted",
            Self::Recovered => "recovered",
            Self::Discarded => "discarded",
            Self::Ambiguous => "ambiguous",
        }
    }

    pub(super) fn can_import(self) -> bool {
        matches!(self, Self::Trusted | Self::Recovered)
    }
}

#[derive(Clone, Copy)]
pub(super) enum Role {
    User,
    Assistant,
}

impl Role {
    pub(super) fn text(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }

    pub(super) fn conversation(self) -> ConversationRole {
        match self {
            Self::User => ConversationRole::User,
            Self::Assistant => ConversationRole::Assistant,
        }
    }
}

struct DecisionInput {
    kind: SourceKind,
    source_id: String,
    session_id: String,
    provenance: Provenance,
    reason: &'static str,
    role: Option<Role>,
    text: Option<String>,
    created_at: Option<String>,
    conversation_session_id: Option<String>,
    conversation_turn_id: Option<String>,
    conversation_message_id: Option<String>,
}

pub(super) struct Decision {
    pub(super) kind: SourceKind,
    pub(super) source_id: String,
    pub(super) session_id: String,
    pub(super) conversation_session_id: Option<String>,
    pub(super) conversation_turn_id: Option<String>,
    pub(super) conversation_message_id: Option<String>,
    pub(super) provenance: Provenance,
    pub(super) admit: bool,
    pub(super) reason: &'static str,
    pub(super) role: Option<Role>,
    pub(super) text: Option<String>,
    pub(super) created_at: Option<String>,
}

pub(super) fn classify_rows(
    transcript_rows: &[HistoricalTranscriptRow],
    app_rows: &[HistoricalAppProjectionRow],
    parse_timestamp: &dyn Fn(&str) -> Option<i64>,
) -> Vec<Decision> {
    transcript_rows
        .iter()
        .map(|row| classify_transcript(row, parse_timestamp))
        .chain(
            app_rows
                .iter()
                .map(|row| classify_app_projection(row, parse_timestamp)),
        )
        .collect()
}

fn classify_transcript(
    row: &HistoricalTranscriptRow,
    parse_timestamp: &dyn Fn(&str) -> Option<i64>,
) -> Decision {
    let stable_id = clean(&row.event_id);
    let stable_session = clean(&row.session_id);
    let source_id = stable_id.clone().unwrap_or_else(|| "unknown".into());
    let session_id = stable_session.clone().unwrap_or_else(|| "unknown".into());
    let timestamp = valid_timestamp(&row.timestamp, parse_timestamp).then(|| row.timestamp.clone());
    let build_decision = |provenance, reason, role, text| {
        decision(DecisionInput {
            kind: SourceKind::Transcript,
            source_id: source_id.clone(),
            session_id: session_id.clone(),
            provenance,
            reason,
            role,
            text,
            created_at: timestamp.clone(),
            conversation_session_id: None,
            conversation_turn_id: None,
            conversation_message_id: None,
        })
    };
    if stable_id.is_none() || stable_session.is_none() || timestamp.is_none() {
        return build_decision(
            Provenance::Ambiguous,
            "missing_stable_transcript_identity",
            None,
            None,
        );
    }
    let payload = row.payload.as_ref();
    let is_placeholder = timestamp_millis(&row.timestamp, parse_timestamp)
        .is_some_and(|value| value <= 0)
        || row.transport.as_deref() == Some("mock")
        || payload
            .and_then(|value| value.get("eventId"))
            .and_then(Value::as_str)
            .is_some_and(|value| value.starts_with("mock:"))
        || payload
            .and_then(|value| value.get("message"))
            .and_then(Value::as_object)
            .and_then(|value| value.get("timestamp"))
            .and_then(Value::as_str)
            .and_then(|value| timestamp_millis(value, parse_timestamp))
            .is_some_and(|value| value <= 0);
    let internal = row.session_id.starts_with("steward/")
        || payload
            .and_then(|value| value.get("route"))
            .and_then(Value::as_object)
            .and_then(|value| value.get("role"))
            .filter(|value| !value.is_null())
            .or_else(|| payload.and_then(|value| value.get("role")))
            .and_then(Value::as_str)
            == Some("steward");
    if is_placeholder || internal {
        return build_decision(
            Provenance::Discarded,
            "transcript_placeholder_or_internal",
            None,
            None,
        );
    }
    let role = match row.kind.as_str() {
        "inbound" => Some(Role::User),
        "outbound" => Some(Role::Assistant),
        _ => None,
    };
    if let Some(role) = role {
        let text = transcript_text(payload);
        if text.is_empty() {
            return build_decision(
                Provenance::Ambiguous,
                "conversation_text_missing",
                Some(role),
                None,
            );
        }
        return build_decision(
            Provenance::Recovered,
            "clean_transcript_message_recovered",
            Some(role),
            Some(text),
        );
    }
    if [
        "delivery",
        "worker_status",
        "session_status",
        "memory_note",
        "system",
    ]
    .contains(&row.kind.as_str())
    {
        return build_decision(
            Provenance::Discarded,
            "transcript_kind_not_semantic",
            None,
            None,
        );
    }
    let reason = if row.kind == "turn" {
        "turn_text_requires_explicit_recovery_policy"
    } else {
        "historical_tool_or_unknown_requires_review"
    };
    build_decision(Provenance::Ambiguous, reason, None, None)
}

fn classify_app_projection(
    row: &HistoricalAppProjectionRow,
    parse_timestamp: &dyn Fn(&str) -> Option<i64>,
) -> Decision {
    let stable_id = clean(&row.id);
    let source_id = stable_id.clone().unwrap_or_else(|| "unknown".into());
    let session_id = app_session_id(&row.chat_id);
    let timestamp =
        valid_timestamp(&row.created_at, parse_timestamp).then(|| row.created_at.clone());
    let conversation_session_id = clean_opt(row.conversation_session_id.as_deref());
    let conversation_turn_id = clean_opt(row.conversation_turn_id.as_deref());
    let conversation_message_id = clean_opt(row.conversation_message_id.as_deref());
    let role = match row.role.as_str() {
        "user" => Some(Role::User),
        "assistant" => Some(Role::Assistant),
        _ => None,
    };
    let build_decision = |provenance, reason, role, text| {
        decision(DecisionInput {
            kind: SourceKind::AppProjection,
            source_id: source_id.clone(),
            session_id: session_id.clone(),
            provenance,
            reason,
            role,
            text,
            created_at: timestamp.clone(),
            conversation_session_id: conversation_session_id.clone(),
            conversation_turn_id: conversation_turn_id.clone(),
            conversation_message_id: conversation_message_id.clone(),
        })
    };
    if stable_id.is_none() || row.chat_id.trim().is_empty() || timestamp.is_none() {
        return build_decision(
            Provenance::Ambiguous,
            "missing_stable_app_projection_identity",
            role,
            None,
        );
    }
    let Some(role) = role else {
        let discarded = ["system_event", "activity", "tool_summary"].contains(&row.role.as_str());
        return build_decision(
            if discarded {
                Provenance::Discarded
            } else {
                Provenance::Ambiguous
            },
            if discarded {
                "app_activity_projection_not_semantic"
            } else {
                "unknown_app_projection_role"
            },
            None,
            None,
        );
    };
    let text = row.text.as_deref().unwrap_or("").trim();
    if text.is_empty() {
        return build_decision(
            Provenance::Ambiguous,
            "conversation_text_missing",
            Some(role),
            None,
        );
    }
    let canonical = conversation_session_id.is_some() && conversation_message_id.is_some();
    build_decision(
        if canonical {
            Provenance::Trusted
        } else {
            Provenance::Recovered
        },
        if canonical {
            "app_projection_has_canonical_refs"
        } else {
            "legacy_app_projection_recovered"
        },
        Some(role),
        Some(text.into()),
    )
}

fn decision(input: DecisionInput) -> Decision {
    let DecisionInput {
        kind,
        source_id,
        session_id,
        provenance,
        reason,
        role,
        text,
        created_at,
        conversation_session_id,
        conversation_turn_id,
        conversation_message_id,
    } = input;
    let text = text.and_then(|value| clean(&value));
    let admit = provenance.can_import() && role.is_some() && text.is_some() && created_at.is_some();
    Decision {
        kind,
        source_id,
        session_id,
        conversation_session_id,
        conversation_turn_id,
        conversation_message_id,
        provenance,
        admit,
        reason,
        role,
        text: admit.then_some(text).flatten(),
        created_at,
    }
}

fn transcript_text(payload: Option<&Map<String, Value>>) -> String {
    let message = payload
        .and_then(|value| value.get("message"))
        .and_then(Value::as_object);
    message
        .and_then(|value| value.get("text"))
        .filter(|value| !value.is_null())
        .or_else(|| payload.and_then(|value| value.get("text")))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned()
}
