use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::types::*;
use super::{ConversationError, ConversationIdentityClock, ConversationResult};

pub(super) fn stringify(value: &Value) -> ConversationResult<String> {
    crate::json::stringify(value).map_err(ConversationError::json)
}

pub(super) fn parse(value: &str) -> ConversationResult<Value> {
    serde_json::from_str(value).map_err(ConversationError::json)
}

pub(super) fn normalize_limit(value: Option<f64>, fallback: u64, max: u64) -> u64 {
    let Some(value) = value.filter(|value| value.is_finite()) else {
        return fallback;
    };
    crate::json::saturating_u64(value.floor().clamp(1.0, max as f64))
}

pub(super) fn next_seq(
    connection: &Connection,
    table: &'static str,
    session_id: &str,
) -> ConversationResult<u64> {
    if !matches!(table, "conversation_turns" | "conversation_messages") {
        return Err(ConversationError::new(
            "conversation_table_invalid",
            "sequence table is invalid",
        ));
    }
    let current: Option<u64> = connection
        .query_row(
            &format!("SELECT MAX(seq) FROM {table} WHERE session_id=?1"),
            [session_id],
            |row| row.get(0),
        )
        .map_err(ConversationError::sqlite)?;
    Ok(current.unwrap_or(0) + 1)
}

pub(super) fn enqueue(
    connection: &Connection,
    clock: &dyn ConversationIdentityClock,
    session_id: &str,
    seq: f64,
    kind: &str,
    payload_ref: &str,
    now: &str,
) -> ConversationResult<()> {
    connection
        .execute(
            "INSERT INTO conversation_projection_outbox (outbox_id,conversation_session_id,seq,\
             kind,payload_ref,created_at) VALUES (?1,?2,?3,?4,?5,?6)",
            params![clock.id("cpo"), session_id, seq, kind, payload_ref, now],
        )
        .map_err(ConversationError::sqlite)?;
    Ok(())
}

pub(super) fn public_revision(connection: &Connection) -> ConversationResult<u64> {
    connection
        .query_row(
            "SELECT revision FROM conversation_public_source_state WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map(|value| value.unwrap_or(0))
        .map_err(ConversationError::sqlite)
}

pub(super) fn bump_public_revision(connection: &Connection) -> ConversationResult<u64> {
    connection
        .execute(
            "UPDATE conversation_public_source_state SET revision=revision+1 WHERE singleton=1",
            [],
        )
        .map_err(ConversationError::sqlite)?;
    public_revision(connection)
}

pub(super) fn message_row(row: &Row<'_>) -> rusqlite::Result<ConversationMessage> {
    Ok(ConversationMessage {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        turn_id: row.get("turn_id")?,
        seq: row.get("seq")?,
        role: role(&row.get::<_, String>("role")?).map_err(sql_conversion)?,
        status: status(&row.get::<_, String>("status")?).map_err(sql_conversion)?,
        visibility: visibility(&row.get::<_, String>("visibility")?).map_err(sql_conversion)?,
        provenance: provenance(&row.get::<_, String>("provenance")?).map_err(sql_conversion)?,
        created_at: row.get("created_at")?,
        compacted_by_summary_id: row.get("compacted_by_summary_id")?,
        source_gateway: row.get("source_gateway")?,
        source_ref: row.get("source_ref")?,
        origin_kind: origin(&row.get::<_, String>("origin_kind")?).map_err(sql_conversion)?,
        origin_ref: row.get("origin_ref")?,
        origin_reason: row.get("origin_reason")?,
        origin_version: row.get("origin_version")?,
        origin_evidence_json: row.get("origin_evidence_json")?,
    })
}

pub(super) fn hydrate_message(
    connection: &Connection,
    message: ConversationMessage,
) -> ConversationResult<ConversationMessageWithParts> {
    let mut statement = connection
        .prepare("SELECT * FROM conversation_parts WHERE message_id=?1 ORDER BY part_index ASC")
        .map_err(ConversationError::sqlite)?;
    let rows = statement
        .query_map([&message.id], |row| {
            Ok((
                row.get::<_, String>("id")?,
                row.get::<_, String>("message_id")?,
                row.get::<_, u64>("part_index")?,
                row.get::<_, String>("kind")?,
                row.get::<_, String>("content_json")?,
                row.get::<_, Option<String>>("tool_call_id")?,
                row.get::<_, Option<String>>("parent_tool_call_id")?,
                row.get::<_, Option<String>>("provider_shape")?,
                row.get::<_, String>("status")?,
            ))
        })
        .map_err(ConversationError::sqlite)?;
    let mut parts = Vec::new();
    for row in rows {
        let (id, message_id, part_index, kind, content, call, parent, provider, part_status) =
            row.map_err(ConversationError::sqlite)?;
        parts.push(ConversationPart {
            id,
            message_id,
            part_index,
            kind: part_kind(&kind)?,
            content_json: parse(&content)?,
            tool_call_id: call,
            parent_tool_call_id: parent,
            provider_shape: provider.as_deref().map(provider_shape).transpose()?,
            status: status(&part_status)?,
        });
    }
    Ok(ConversationMessageWithParts { message, parts })
}

pub(super) fn read_message(
    connection: &Connection,
    message_id: &str,
) -> ConversationResult<Option<ConversationMessageWithParts>> {
    let message = connection
        .query_row(
            "SELECT * FROM conversation_messages WHERE id=?1",
            [message_id],
            message_row,
        )
        .optional()
        .map_err(ConversationError::sqlite)?;
    message
        .map(|message| hydrate_message(connection, message))
        .transpose()
}

pub(super) fn source_hash(messages: &[ConversationMessageWithParts]) -> ConversationResult<String> {
    let mut hash = SourceHasher::new();
    for message in messages {
        hash.push(message)?;
    }
    Ok(hash.finish())
}

pub(super) struct SourceHasher {
    hash: Sha256,
    first: bool,
}

impl SourceHasher {
    pub(super) fn new() -> Self {
        let mut hash = Sha256::new();
        hash.update(b"[");
        Self { hash, first: true }
    }

    pub(super) fn push(
        &mut self,
        message: &ConversationMessageWithParts,
    ) -> ConversationResult<()> {
        if !self.first {
            self.hash.update(b",");
        }
        self.first = false;
        self.hash
            .update(stringify(&source_payload(message)?)?.as_bytes());
        Ok(())
    }

    pub(super) fn finish(mut self) -> String {
        self.hash.update(b"]");
        format!("sha256:{:x}", self.hash.finalize())
    }
}

fn source_payload(message: &ConversationMessageWithParts) -> ConversationResult<Value> {
    let mut object = Map::new();
    object.insert("id".into(), Value::String(message.message.id.clone()));
    object.insert(
        "session_id".into(),
        Value::String(message.message.session_id.clone()),
    );
    object.insert(
        "turn_id".into(),
        option_string(message.message.turn_id.as_ref()),
    );
    object.insert("seq".into(), Value::from(message.message.seq));
    object.insert(
        "role".into(),
        Value::String(role_text(message.message.role).into()),
    );
    object.insert(
        "visibility".into(),
        Value::String(visibility_text(message.message.visibility).into()),
    );
    object.insert(
        "provenance".into(),
        Value::String(provenance_text(message.message.provenance).into()),
    );
    object.insert(
        "created_at".into(),
        Value::String(message.message.created_at.clone()),
    );
    object.insert(
        "source_gateway".into(),
        option_string(message.message.source_gateway.as_ref()),
    );
    object.insert(
        "source_ref".into(),
        option_string(message.message.source_ref.as_ref()),
    );
    object.insert(
        "parts".into(),
        Value::Array(message.parts.iter().map(part_payload).collect()),
    );
    Ok(Value::Object(object))
}

fn part_payload(part: &ConversationPart) -> Value {
    let mut object = Map::new();
    object.insert("id".into(), Value::String(part.id.clone()));
    object.insert("part_index".into(), Value::from(part.part_index));
    object.insert(
        "kind".into(),
        Value::String(part_kind_text(part.kind).into()),
    );
    object.insert("content_json".into(), part.content_json.clone());
    object.insert(
        "tool_call_id".into(),
        option_string(part.tool_call_id.as_ref()),
    );
    object.insert(
        "parent_tool_call_id".into(),
        option_string(part.parent_tool_call_id.as_ref()),
    );
    object.insert(
        "provider_shape".into(),
        part.provider_shape
            .map(|v| Value::String(provider_shape_text(v).into()))
            .unwrap_or(Value::Null),
    );
    object.insert(
        "status".into(),
        Value::String(status_text(part.status).into()),
    );
    Value::Object(object)
}

fn option_string(value: Option<&String>) -> Value {
    value.cloned().map(Value::String).unwrap_or(Value::Null)
}

pub(super) fn role_text(value: ConversationRole) -> &'static str {
    match value {
        ConversationRole::System => "system",
        ConversationRole::Developer => "developer",
        ConversationRole::User => "user",
        ConversationRole::Assistant => "assistant",
        ConversationRole::Tool => "tool",
    }
}
pub(super) fn status_text(value: ConversationStatus) -> &'static str {
    match value {
        ConversationStatus::Pending => "pending",
        ConversationStatus::Complete => "complete",
        ConversationStatus::Failed => "failed",
        ConversationStatus::Compacted => "compacted",
    }
}
pub(super) fn visibility_text(value: ConversationVisibility) -> &'static str {
    match value {
        ConversationVisibility::Model => "model",
        ConversationVisibility::User => "user",
        ConversationVisibility::Operator => "operator",
        ConversationVisibility::AuditLink => "audit_link",
    }
}
pub(super) fn provenance_text(value: ConversationProvenance) -> &'static str {
    match value {
        ConversationProvenance::Trusted => "trusted",
        ConversationProvenance::Recovered => "recovered",
        ConversationProvenance::Imported => "imported",
        ConversationProvenance::SyntheticSummary => "synthetic_summary",
    }
}
pub(super) fn origin_text(value: ConversationOriginKind) -> &'static str {
    match value {
        ConversationOriginKind::UserInput => "user_input",
        ConversationOriginKind::AssistantPublic => "assistant_public",
        ConversationOriginKind::InternalControl => "internal_control",
        ConversationOriginKind::Unknown => "unknown",
    }
}
pub(super) fn part_kind_text(value: ConversationPartKind) -> &'static str {
    match value {
        ConversationPartKind::Text => "text",
        ConversationPartKind::AttachmentRef => "attachment_ref",
        ConversationPartKind::ToolCall => "tool_call",
        ConversationPartKind::ToolResult => "tool_result",
        ConversationPartKind::SummaryRef => "summary_ref",
        ConversationPartKind::MessageContent => "message_content",
    }
}
pub(super) fn provider_shape_text(value: ConversationProviderShape) -> &'static str {
    match value {
        ConversationProviderShape::Openai => "openai",
        ConversationProviderShape::Anthropic => "anthropic",
        ConversationProviderShape::Generic => "generic",
    }
}
pub(super) fn outcome_text(value: TurnOutcomeKind) -> &'static str {
    match value {
        TurnOutcomeKind::Delivered => "delivered",
        TurnOutcomeKind::Failed => "failed",
        TurnOutcomeKind::Cancelled => "cancelled",
        TurnOutcomeKind::Recoverable => "recoverable",
    }
}

fn role(value: &str) -> ConversationResult<ConversationRole> {
    match value {
        "system" => Ok(ConversationRole::System),
        "developer" => Ok(ConversationRole::Developer),
        "user" => Ok(ConversationRole::User),
        "assistant" => Ok(ConversationRole::Assistant),
        "tool" => Ok(ConversationRole::Tool),
        _ => Err(invalid("role", value)),
    }
}
fn status(value: &str) -> ConversationResult<ConversationStatus> {
    match value {
        "pending" => Ok(ConversationStatus::Pending),
        "complete" => Ok(ConversationStatus::Complete),
        "failed" => Ok(ConversationStatus::Failed),
        "compacted" => Ok(ConversationStatus::Compacted),
        _ => Err(invalid("status", value)),
    }
}
fn visibility(value: &str) -> ConversationResult<ConversationVisibility> {
    match value {
        "model" => Ok(ConversationVisibility::Model),
        "user" => Ok(ConversationVisibility::User),
        "operator" => Ok(ConversationVisibility::Operator),
        "audit_link" => Ok(ConversationVisibility::AuditLink),
        _ => Err(invalid("visibility", value)),
    }
}
fn provenance(value: &str) -> ConversationResult<ConversationProvenance> {
    match value {
        "trusted" => Ok(ConversationProvenance::Trusted),
        "recovered" => Ok(ConversationProvenance::Recovered),
        "imported" => Ok(ConversationProvenance::Imported),
        "synthetic_summary" => Ok(ConversationProvenance::SyntheticSummary),
        _ => Err(invalid("provenance", value)),
    }
}
fn origin(value: &str) -> ConversationResult<ConversationOriginKind> {
    match value {
        "user_input" => Ok(ConversationOriginKind::UserInput),
        "assistant_public" => Ok(ConversationOriginKind::AssistantPublic),
        "internal_control" => Ok(ConversationOriginKind::InternalControl),
        "unknown" => Ok(ConversationOriginKind::Unknown),
        _ => Err(invalid("origin", value)),
    }
}
fn part_kind(value: &str) -> ConversationResult<ConversationPartKind> {
    match value {
        "text" => Ok(ConversationPartKind::Text),
        "attachment_ref" => Ok(ConversationPartKind::AttachmentRef),
        "tool_call" => Ok(ConversationPartKind::ToolCall),
        "tool_result" => Ok(ConversationPartKind::ToolResult),
        "summary_ref" => Ok(ConversationPartKind::SummaryRef),
        "message_content" => Ok(ConversationPartKind::MessageContent),
        _ => Err(invalid("part kind", value)),
    }
}
fn provider_shape(value: &str) -> ConversationResult<ConversationProviderShape> {
    match value {
        "openai" => Ok(ConversationProviderShape::Openai),
        "anthropic" => Ok(ConversationProviderShape::Anthropic),
        "generic" => Ok(ConversationProviderShape::Generic),
        _ => Err(invalid("provider shape", value)),
    }
}
pub(super) fn outcome(value: &str) -> ConversationResult<TurnOutcomeKind> {
    match value {
        "delivered" => Ok(TurnOutcomeKind::Delivered),
        "failed" => Ok(TurnOutcomeKind::Failed),
        "cancelled" => Ok(TurnOutcomeKind::Cancelled),
        "recoverable" => Ok(TurnOutcomeKind::Recoverable),
        _ => Err(invalid("outcome", value)),
    }
}

fn invalid(kind: &str, value: &str) -> ConversationError {
    ConversationError::new(
        "conversation_value_invalid",
        format!("invalid {kind}: {value}"),
    )
}
fn sql_conversion(error: ConversationError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}
