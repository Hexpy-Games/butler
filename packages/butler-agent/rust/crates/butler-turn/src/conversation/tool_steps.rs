use rusqlite::params;
use serde_json::Value;

use super::admission::sanitizer::{safe_input_label, safe_optional};
use super::{AgentConversationStore, ConversationError, ConversationResult};

pub(crate) struct ToolStepWrite<'a> {
    pub turn_id: &'a str,
    pub tool_call_id: &'a str,
    pub tool_name: Option<&'a Value>,
    pub label: Option<&'a Value>,
    pub input_label: Option<&'a str>,
    pub status: Option<&'static str>,
    pub created_at: Option<&'a str>,
}

const INSERT: &str = "INSERT INTO conversation_tool_steps
    (turn_id, session_id, tool_call_id, ord, safe_tool_name, safe_label, safe_input_label,
     status, started_at, completed_at)
    SELECT id, session_id, ?2,
      (SELECT COALESCE(MAX(ord)+1, 0) FROM conversation_tool_steps WHERE turn_id=?1),
      ?3, ?4, ?5, ?6, ?7, ?8
    FROM conversation_turns WHERE id=?1
      AND NOT EXISTS (SELECT 1 FROM conversation_turn_outcomes WHERE turn_id=?1)
    ON CONFLICT(turn_id, tool_call_id)";

impl AgentConversationStore {
    pub(crate) async fn record_tool_step(&self, step: ToolStepWrite<'_>) -> ConversationResult<()> {
        let turn_id = step.turn_id.to_owned();
        let tool_call_id = step.tool_call_id.to_owned();
        let tool_name = safe_optional(step.tool_name);
        let label = safe_optional(step.label);
        let input_label = safe_input_label(step.input_label);
        let status = step.status;
        let now = step
            .created_at
            .map_or_else(|| self.identity_clock().now_iso(), str::to_owned);
        self.execute(move |db| {
            let conflict = if status.is_some() {
                "DO UPDATE SET status=excluded.status, completed_at=excluded.completed_at,
                 safe_tool_name=COALESCE(excluded.safe_tool_name, safe_tool_name),
                 safe_label=COALESCE(excluded.safe_label, safe_label),
                 safe_input_label=COALESCE(excluded.safe_input_label, safe_input_label)"
            } else {
                "DO NOTHING"
            };
            db.execute(
                &format!("{INSERT} {conflict}"),
                params![
                    turn_id,
                    tool_call_id,
                    tool_name,
                    label,
                    input_label,
                    status,
                    now,
                    status.map(|_| &now)
                ],
            )
            .map_err(ConversationError::sqlite)?;
            Ok(())
        })
        .await
    }
}
