//! Durable pattern notes and proposal snapshots.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Window {
    pub(super) days: Vec<String>,
    pub(super) start: String,
    pub(super) end: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Evidence {
    pub(super) count: u64,
    pub(super) first_at: DateTime<Utc>,
    pub(super) last_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Pattern {
    pub(super) id: String,
    pub(super) title: String,
    pub(super) intent: String,
    pub(super) window: Window,
    pub(super) evidence: Evidence,
    pub(super) created_at: DateTime<Utc>,
    pub(super) updated_at: DateTime<Utc>,
    pub(super) proposed_at: Option<DateTime<Utc>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Removed {
    pub(super) id: String,
    pub(super) title: String,
    pub(super) intent: String,
    pub(super) window: Window,
    pub(super) reason: String,
    pub(super) removed_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Schedule {
    pub(super) r#type: String,
    pub(super) time: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Action {
    pub(super) kind: String,
    pub(super) title: String,
    pub(super) prompt: String,
    pub(super) schedule: Schedule,
    pub(super) deliver_to: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Candidate {
    pub(super) pattern_id: String,
    pub(super) state: String,
    pub(super) title: String,
    pub(super) action: Action,
    pub(super) evidence: Evidence,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Bundle {
    pub(super) id: String,
    pub(super) run_id: String,
    pub(super) created_at: DateTime<Utc>,
    pub(super) level: String,
    pub(super) candidates: Vec<Candidate>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct PatternStore {
    pub(super) schema: String,
    pub(super) revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) cursor: Option<DateTime<Utc>>,
    #[serde(default)]
    pub(super) cursor_offset: usize,
    pub(super) patterns: Vec<Pattern>,
    pub(super) removed: Vec<Removed>,
    pub(super) bundles: Vec<Bundle>,
}
impl Default for PatternStore {
    fn default() -> Self {
        Self {
            schema: "butler.cognition.patterns.v1".into(),
            revision: 0,
            cursor: None,
            cursor_offset: 0,
            patterns: vec![],
            removed: vec![],
            bundles: vec![],
        }
    }
}
/// Source facts only; the model assigns all meaning.
#[derive(Clone, Debug, Serialize)]
pub struct PatternEvent {
    /// Canonical message identity.
    pub id: String,
    /// Structural message origin kind.
    pub kind: String,
    /// Structural session kind: chats, project or work.
    pub session: String,
    #[serde(skip)]
    /// UTC source timestamp, used only to compute evidence spans.
    pub created_at: DateTime<Utc>,
    /// Local date, weekday and time for the model.
    pub at_local: String,
    /// Source text bounded to 600 Unicode characters.
    pub text: String,
    /// Tool names when cheaply exposed by the source.
    pub tools: Vec<String>,
}
