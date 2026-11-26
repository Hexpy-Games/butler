//! What the main hands a registered computer: a read-only copy of its
//! all-chats instructions and its profile.
use std::sync::Arc;

use crate::host::runtime::MemoryReads;
use butler_gateway::gateway::{
    GatewayApplicationError, RemovedComputerMessage, RemovedComputerTurn,
};
use butler_memory::cognition::RememberedRuleOwner;
use butler_memory::profile::ProfileService;
use butler_turn::context_ports::{ProfilePromptPort, PromptProjectionInput};
use butler_turn::conversation::TransferToolStep;
use butler_turn::conversation::{AgentConversationStore, CanonicalMemoryReadBinding, TransferTurn};
use butler_turn::remote_memory::{CopiedRule, MemoryCopy};
use serde::Deserialize;
use serde_json::{Value, json};

pub(crate) struct ComputerMemory {
    pub(crate) conversations: Arc<AgentConversationStore>,
    pub(crate) rules: Arc<RememberedRuleOwner>,
    pub(crate) profile: Arc<ProfileService>,
    pub(crate) reads: MemoryReads,
}

impl ComputerMemory {
    /// Project and chat-scoped instructions stay on the main: a computer's
    /// sessions have no main project, and their chat instructions are task 9.
    pub(super) async fn copy(&self) -> Result<Value, GatewayApplicationError> {
        let rules = self
            .rules
            .list()
            .await
            .map_err(|_| GatewayApplicationError::internal())?;
        let input = PromptProjectionInput {
            session_id: "",
            project_id: None,
        };
        let naming_profile = self
            .profile
            .naming_profile(&input)
            .await
            .map_err(|_| GatewayApplicationError::internal())?;
        let runtime_profile = self
            .profile
            .runtime_profile(&input)
            .await
            .map_err(|_| GatewayApplicationError::internal())?;
        let rules = rules
            .into_iter()
            .filter(|rule| rule.project_id.is_none() && rule.scope_session_id.is_none())
            .map(|rule| CopiedRule {
                handle: rule.handle,
                text: rule.text,
                revision: rule.revision,
                expires_at: rule.expires_at,
            })
            .collect();
        serde_json::to_value(MemoryCopy {
            pending_ids: Vec::new(),
            rules,
            naming_profile,
            runtime_profile,
        })
        .map_err(GatewayApplicationError::internal_from)
    }
}

pub(super) async fn session_turns(
    root: std::path::PathBuf,
    computer_id: String,
    runtime_session_id: String,
) -> Result<Vec<RemovedComputerTurn>, GatewayApplicationError> {
    use butler_turn::conversation::conversation_store_path;
    tokio::task::spawn_blocking(move || {
        let path = conversation_store_path(&root);
        if !path
            .try_exists()
            .map_err(GatewayApplicationError::internal_from)?
        {
            return Ok(Vec::new());
        }
        read_session_turns(
            &path,
            &format!("computer:{computer_id}"),
            &runtime_session_id,
        )
        .map_err(GatewayApplicationError::internal_from)
    })
    .await
    .map_err(GatewayApplicationError::internal_from)?
}

fn read_session_turns(
    path: &std::path::Path,
    gateway: &str,
    runtime_session_id: &str,
) -> rusqlite::Result<Vec<RemovedComputerTurn>> {
    let mut db =
        butler_platform::sqlite::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let tx = db.transaction()?;
    let mut turns = tx.prepare(
        "SELECT t.id, t.status, t.started_at, t.completed_at
         FROM conversation_bindings b
         JOIN conversation_turns t ON t.session_id = b.conversation_session_id
         JOIN conversation_turn_outcomes o ON o.turn_id = t.id
         WHERE b.gateway = ?1 AND b.external_session_id = ?2
           AND t.status IN ('complete', 'failed', 'aborted')
         ORDER BY t.seq",
    )?;
    // The outcome identifies public messages among model-visible messages.
    let mut messages = tx.prepare(
        "SELECT m.id, m.role, group_concat(p.content_json ->> 'text', char(10) ORDER BY p.part_index),
                m.created_at
         FROM conversation_messages m
         JOIN conversation_parts p ON p.message_id = m.id
         JOIN conversation_turn_outcomes o ON o.turn_id = m.turn_id
         WHERE m.turn_id = ?1 AND m.role IN ('user', 'assistant')
           AND (m.visibility = 'user' OR (m.visibility = 'model' AND (
               (m.role = 'user' AND m.id = o.request_message_id)
               OR (m.role = 'assistant' AND m.id = o.public_assistant_message_id)
           )))
           AND p.kind = 'text' AND json_type(p.content_json, '$.text') = 'text'
         GROUP BY m.id
         ORDER BY m.seq",
    )?;
    let has_tools: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_tool_steps')",
        [], |row| row.get(0),
    )?;
    let mut tools = has_tools.then(|| tx.prepare(
        "SELECT tool_call_id, ord, safe_tool_name, safe_label, safe_input_label, status,
                started_at, completed_at FROM conversation_tool_steps WHERE turn_id=?1 ORDER BY ord",
    )).transpose()?;
    turns
        .query_map([gateway, runtime_session_id], |row| {
            let id: String = row.get(0)?;
            let messages = messages
                .query_map([&id], |message| {
                    Ok(RemovedComputerMessage {
                        id: message.get(0)?,
                        role: message.get(1)?,
                        text: message.get(2)?,
                        created_at: message.get(3)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(RemovedComputerTurn {
                tools: read_turn_tools(tools.as_mut(), &id)?,
                id,
                status: row.get(1)?,
                started_at: row.get(2)?,
                completed_at: row.get(3)?,
                messages,
            })
        })?
        .collect()
}

fn read_turn_tools(
    query: Option<&mut rusqlite::Statement<'_>>,
    id: &str,
) -> rusqlite::Result<Vec<TransferToolStep>> {
    let Some(query) = query else {
        return Ok(Vec::new());
    };
    query
        .query_map([id], |row| {
            Ok(TransferToolStep {
                tool_call_id: row.get(0)?,
                ord: row.get(1)?,
                safe_tool_name: row.get(2)?,
                safe_label: row.get(3)?,
                safe_input_label: row.get(4)?,
                status: row.get(5)?,
                started_at: row.get(6)?,
                completed_at: row.get(7)?,
            })
        })?
        .collect()
}

#[derive(Deserialize)]
struct ComputerRead {
    read_id: String,
    session_id: String,
    turn_id: String,
    tool: String,
    arguments: Value,
    current_user_message: String,
    operation_id: String,
}

impl ComputerMemory {
    pub(super) async fn import_turn(
        &self,
        computer_id: String,
        line: Vec<u8>,
    ) -> Result<bool, GatewayApplicationError> {
        let skipped = || GatewayApplicationError::Public {
            status: 422,
            code: "transfer_skipped".into(),
            message: "transfer_skipped".into(),
            source: None,
        };
        let turn: TransferTurn = serde_json::from_slice(&line).map_err(|_| skipped())?;
        self.conversations
            .import_transfer_turn(computer_id, turn)
            .await
            .map_err(|error| {
                if error.message().starts_with("transfer_") {
                    skipped()
                } else {
                    GatewayApplicationError::internal()
                }
            })
    }

    /// Answers a computer's read with the main's own tool, as for a
    /// conversation held elsewhere: only scopes over all chats are readable.
    pub(super) async fn read(&self, request: Value) -> Result<Value, GatewayApplicationError> {
        let read: ComputerRead =
            serde_json::from_value(request).map_err(GatewayApplicationError::internal_from)?;
        let binding = CanonicalMemoryReadBinding {
            runtime_session_id: read.session_id,
            turn_id: read.turn_id,
            project_id: None,
            usage_root: None,
            usage_role: None,
            elsewhere: true,
        };
        let reads = &self.reads;
        let result = match read.tool.as_str() {
            "query_memory" => reads
                .query
                .query(binding, read.arguments)
                .await
                .map_err(|e| e.code()),
            "recall_memory" => reads
                .recall
                .recall_tool(
                    binding,
                    read.current_user_message,
                    read.operation_id,
                    read.arguments,
                )
                .await
                .map_err(|e| e.code()),
            "list_conversation_sessions" => reads
                .tools
                .list(binding, read.arguments)
                .await
                .map_err(|e| e.code()),
            "read_conversation_session" => reads
                .reference
                .read(binding, read.arguments)
                .await
                .map_err(|e| e.code()),
            _ => Err("unsupported_tool"),
        };
        Ok(match result {
            Ok(value) => json!({"read_id": read.read_id, "result": value}),
            Err(code) => json!({"read_id": read.read_id, "error": code}),
        })
    }
}
