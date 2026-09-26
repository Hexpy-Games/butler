mod origin;
mod read;
mod status;

pub(in crate::conversation) use read::{
    around, cognition, projection, referenced_hash, semantic_tail,
};
pub(in crate::conversation) use status::status_message_facts;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use super::codec::*;
use super::types::*;
use super::{
    AgentConversationStore, ConversationError, ConversationIdentityClock, ConversationResult,
};

impl AgentConversationStore {
    pub(crate) async fn append_user_message(
        &self,
        mut input: AppendMessageInput,
    ) -> ConversationResult<ConversationMessageWithParts> {
        input.role = ConversationRole::User;
        self.append_message(input).await
    }

    pub(crate) async fn append_assistant_message(
        &self,
        mut input: AppendMessageInput,
    ) -> ConversationResult<ConversationMessageWithParts> {
        input.role = ConversationRole::Assistant;
        self.append_message(input).await
    }

    async fn append_message(
        &self,
        input: AppendMessageInput,
    ) -> ConversationResult<ConversationMessageWithParts> {
        let clock = self.identity_clock().clone();
        let now = input.now.clone().unwrap_or_else(|| clock.now_iso());
        self.execute(move |connection| append(connection, clock.as_ref(), input, &now))
            .await
    }

    pub(crate) async fn append_tool_call(
        &self,
        input: AppendToolPartInput,
    ) -> ConversationResult<ConversationPart> {
        self.append_tool_part(ConversationPartKind::ToolCall, input)
            .await
    }

    pub(crate) async fn append_tool_result(
        &self,
        input: AppendToolPartInput,
    ) -> ConversationResult<ConversationPart> {
        self.append_tool_part(ConversationPartKind::ToolResult, input)
            .await
    }

    async fn append_tool_part(
        &self,
        kind: ConversationPartKind,
        input: AppendToolPartInput,
    ) -> ConversationResult<ConversationPart> {
        let clock = self.identity_clock().clone();
        self.execute(move |connection| insert_tool_part(connection, clock.as_ref(), kind, input))
            .await
    }
}

fn append(
    connection: &mut Connection,
    clock: &dyn ConversationIdentityClock,
    input: AppendMessageInput,
    now: &str,
) -> ConversationResult<ConversationMessageWithParts> {
    let transaction = connection
        .transaction()
        .map_err(ConversationError::sqlite)?;
    let hydrated = append_in_transaction(&transaction, clock, input, now)?;
    transaction.commit().map_err(ConversationError::sqlite)?;
    Ok(hydrated)
}

pub(super) fn append_in_transaction(
    connection: &Connection,
    clock: &dyn ConversationIdentityClock,
    input: AppendMessageInput,
    now: &str,
) -> ConversationResult<ConversationMessageWithParts> {
    let message = ConversationMessage {
        id: input.message_id.unwrap_or_else(|| clock.id("cm")),
        session_id: input.session_id.clone(),
        turn_id: input.turn_id,
        seq: next_seq(connection, "conversation_messages", &input.session_id)?,
        role: input.role,
        status: input.status.unwrap_or(ConversationStatus::Complete),
        visibility: input.visibility.unwrap_or(ConversationVisibility::Model),
        provenance: input.provenance.unwrap_or(ConversationProvenance::Trusted),
        created_at: now.to_string(),
        compacted_by_summary_id: None,
        source_gateway: input.source_gateway,
        source_ref: input.source_ref,
        origin_kind: input.origin_kind.unwrap_or(ConversationOriginKind::Unknown),
        origin_ref: input.origin_ref,
        origin_reason: input.origin_reason,
        origin_version: input.origin_version,
        origin_evidence_json: input
            .origin_evidence
            .map(|value| {
                serde_json::to_value(value)
                    .map_err(ConversationError::json)
                    .and_then(|value| stringify(&value))
            })
            .transpose()?,
    };
    insert_message(connection, &message)?;
    let parts = input
        .parts
        .filter(|parts| !parts.is_empty())
        .unwrap_or_else(|| {
            vec![MessagePartInput {
                kind: ConversationPartKind::Text,
                content_json: json!({"text":input.text}),
                tool_call_id: None,
                parent_tool_call_id: None,
                provider_shape: None,
                status: None,
            }]
        });
    for part in &parts {
        insert_part(connection, clock, &message.id, part)?;
    }
    if message.visibility == ConversationVisibility::Model
        && ((message.role == ConversationRole::User
            && message.origin_kind == ConversationOriginKind::UserInput)
            || (message.role == ConversationRole::Assistant
                && message.origin_kind == ConversationOriginKind::AssistantPublic))
        && parts.iter().any(canonical_scalar)
    {
        bump_public_revision(connection)?;
    }
    enqueue(
        connection,
        clock,
        &message.session_id,
        message.seq as f64,
        "conversation.message_committed",
        &message.id,
        now,
    )?;
    let hydrated = hydrate_message(connection, message)?;
    Ok(hydrated)
}

fn insert_message(
    connection: &Connection,
    message: &ConversationMessage,
) -> ConversationResult<()> {
    connection
        .execute(
            "INSERT INTO conversation_messages \
         (id,session_id,turn_id,seq,role,status,visibility,provenance,created_at,\
         compacted_by_summary_id,source_gateway,source_ref,origin_kind,origin_ref,\
         origin_reason,origin_version,origin_evidence_json) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
            params![
                message.id,
                message.session_id,
                message.turn_id,
                message.seq,
                role_text(message.role),
                status_text(message.status),
                visibility_text(message.visibility),
                provenance_text(message.provenance),
                message.created_at,
                message.compacted_by_summary_id,
                message.source_gateway,
                message.source_ref,
                origin_text(message.origin_kind),
                message.origin_ref,
                message.origin_reason,
                message.origin_version,
                message.origin_evidence_json
            ],
        )
        .map_err(ConversationError::sqlite)?;
    Ok(())
}

fn insert_part(
    connection: &Connection,
    clock: &dyn ConversationIdentityClock,
    message_id: &str,
    input: &MessagePartInput,
) -> ConversationResult<ConversationPart> {
    let index: Option<u64> = connection
        .query_row(
            "SELECT MAX(part_index) FROM conversation_parts WHERE message_id=?1",
            [message_id],
            |row| row.get(0),
        )
        .map_err(ConversationError::sqlite)?;
    let part = ConversationPart {
        id: clock.id("cp"),
        message_id: message_id.into(),
        part_index: index.map(|v| v + 1).unwrap_or(0),
        kind: input.kind,
        content_json: input.content_json.clone(),
        tool_call_id: input.tool_call_id.clone(),
        parent_tool_call_id: input.parent_tool_call_id.clone(),
        provider_shape: input.provider_shape,
        status: input.status.unwrap_or(ConversationStatus::Complete),
    };
    connection
        .execute(
            "INSERT INTO conversation_parts \
         (id,message_id,part_index,kind,content_json,tool_call_id,parent_tool_call_id,\
         provider_shape,status) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                part.id,
                part.message_id,
                part.part_index,
                part_kind_text(part.kind),
                stringify(&part.content_json)?,
                part.tool_call_id,
                part.parent_tool_call_id,
                part.provider_shape.map(provider_shape_text),
                status_text(part.status)
            ],
        )
        .map_err(ConversationError::sqlite)?;
    Ok(part)
}

fn insert_tool_part(
    connection: &mut Connection,
    clock: &dyn ConversationIdentityClock,
    kind: ConversationPartKind,
    input: AppendToolPartInput,
) -> ConversationResult<ConversationPart> {
    let message = connection
        .query_row(
            "SELECT * FROM conversation_messages WHERE id=?1",
            [&input.message_id],
            message_row,
        )
        .optional()
        .map_err(ConversationError::sqlite)?
        .ok_or_else(|| {
            ConversationError::new(
                "conversation_message_not_found",
                format!("Conversation message not found: {}", input.message_id),
            )
        })?;
    let transaction = connection
        .transaction()
        .map_err(ConversationError::sqlite)?;
    let part = insert_part(
        &transaction,
        clock,
        &input.message_id,
        &MessagePartInput {
            kind,
            content_json: input.content_json,
            tool_call_id: Some(input.tool_call_id),
            parent_tool_call_id: input.parent_tool_call_id,
            provider_shape: input.provider_shape,
            status: input.status,
        },
    )?;
    enqueue(
        &transaction,
        clock,
        &message.session_id,
        message.seq as f64,
        if kind == ConversationPartKind::ToolCall {
            "conversation.tool_call_committed"
        } else {
            "conversation.tool_result_committed"
        },
        &part.id,
        &clock.now_iso(),
    )?;
    transaction.commit().map_err(ConversationError::sqlite)?;
    Ok(part)
}

fn canonical_scalar(part: &MessagePartInput) -> bool {
    match part.kind {
        ConversationPartKind::Text => part
            .content_json
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty()),
        ConversationPartKind::MessageContent => part.content_json.as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item.get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|v| !v.is_empty())
            })
        }),
        _ => false,
    }
}
