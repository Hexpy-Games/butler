//! Volatile reminders for the user's open questions.
mod budget;

use butler_turn::btcc::BtccError;
use serde_json::{Value, json};

const SECTION: &str = "## Open asks\nQuestions you asked the user that are still waiting for an answer, newest first, as JSON below. Each stays open until the user answers it on its card or in chat, or drops it.\n- If the user's message answers or drops one, call resolve_ask for it before anything else, quoting the user's own words.\n- Otherwise, if any are still open when you finish, end the reply with one short line naming up to three by title. Never repeat a question in full or ask it again, and never mention one the user just dropped.\n- `settled` lists asks the user answered on a card since your last reply. Act on them if needed, without restating them.\n- Approvals waiting on a card are not listed here; only the user's click settles them.";

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
    pub(in crate::host::guided) fn replace_canon(&mut self, entry: Option<Value>) {
        self.entries.retain(|v| v["kind"] != "canon_proposal");
        if let Some(entry) = entry {
            self.entries.push(entry);
        }
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
        budget::encode(content).map(|s| Some(format!("{SECTION}\n{s}")))
    }
}
