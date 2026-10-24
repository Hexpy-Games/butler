//! Volatile reminders. Canon can contribute entries without sharing lifecycle authority.
use butler_turn::btcc::BtccError;
use serde_json::{Value, json};

const SECTION: &str = "## Open asks
What you asked the user that still waits for an answer, newest first, as JSON below. Each stays open until the user answers on its card or in chat, or drops it.
- If the user's message answers, accepts, declines or drops one, call resolve_ask for it first, quoting the user's words.
- If the message changes what an open canon draft should contain, call canon_propose again; the new draft replaces it.
- Otherwise, if any remain open after your reply, end the reply with one short line naming up to three by title. Never repeat a question in full, never ask it again, and never mention one the user just dropped.
- `settled` lists asks the user answered on a card since your last reply; act on them if needed, without restating them.
- Approvals waiting on a card are not listed; only the user's click settles them.";

pub(in crate::host::guided) struct Reminders {
    entries: Vec<Value>,
}
impl Reminders {
    pub(in crate::host::guided) fn new(mut entries: Vec<Value>) -> Self {
        entries.sort_by(|a, b| {
            b["created_at"]
                .as_str()
                .cmp(&a["created_at"].as_str())
                .then_with(|| b["ask_id"].as_str().cmp(&a["ask_id"].as_str()))
        });
        let mut seen = std::collections::HashSet::new();
        entries.retain(|v| seen.insert(v["ask_id"].clone().to_string()));
        Self { entries }
    }
    pub(in crate::host::guided) fn remove(&mut self, ask_id: &str) {
        self.entries.retain(|v| v["ask_id"] != ask_id);
    }
    pub(super) fn render(&self) -> Result<Option<String>, BtccError> {
        if self.entries.is_empty() {
            return Ok(None);
        }
        let open = self
            .entries
            .iter()
            .filter(|v| v["resolved_at"].is_null())
            .collect::<Vec<_>>();
        let mut settled = self
            .entries
            .iter()
            .filter(|v| !v["resolved_at"].is_null())
            .collect::<Vec<_>>();
        settled.sort_by(|a, b| b["resolved_at"].as_str().cmp(&a["resolved_at"].as_str()));
        let settled_room = 8_usize.saturating_sub(open.len());
        let more = open.len().saturating_sub(8);
        let settled_more = settled.len().saturating_sub(settled_room);
        let mut content = json!({"open":open.iter().take(8).collect::<Vec<_>>(),
            "more":more,"settled":settled.into_iter().take(settled_room).collect::<Vec<_>>()});
        if settled_more > 0 {
            content["settled_more"] = json!(settled_more);
        }
        serde_json::to_string(&content)
            .map(|s| Some(format!("{SECTION}\n{s}")))
            .map_err(|e| BtccError::relayed("ask_reminders_invalid", e.to_string()))
    }
}
