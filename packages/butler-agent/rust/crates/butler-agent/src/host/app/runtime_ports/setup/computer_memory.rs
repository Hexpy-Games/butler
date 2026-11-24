//! What the main hands a registered computer: a read-only copy of its
//! all-chats instructions and its profile.
use std::sync::Arc;

use crate::host::runtime::MemoryReads;
use butler_gateway::gateway::GatewayApplicationError;
use butler_memory::cognition::RememberedRuleOwner;
use butler_memory::profile::ProfileService;
use butler_turn::context_ports::{ProfilePromptPort, PromptProjectionInput};
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
) -> Result<Vec<TransferTurn>, GatewayApplicationError> {
    use butler_turn::conversation::{ConversationSourceReader, conversation_store_path};
    tokio::task::spawn_blocking(move || {
        let path = conversation_store_path(&root);
        if !path
            .try_exists()
            .map_err(GatewayApplicationError::internal_from)?
        {
            return Ok(Vec::new());
        }
        ConversationSourceReader::open(&path)
            .and_then(|reader| {
                reader.session_transfer(&format!("computer:{computer_id}"), &runtime_session_id)
            })
            .map_err(GatewayApplicationError::internal_from)
    })
    .await
    .map_err(GatewayApplicationError::internal_from)?
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
