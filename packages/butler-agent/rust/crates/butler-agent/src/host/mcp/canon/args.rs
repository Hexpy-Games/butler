use rmcp::schemars::{self, JsonSchema};
use serde::{Deserialize, Serialize};
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct List {
    pub(super) project: Option<String>,
    pub(super) plan_id: Option<String>,
    pub(super) include_done: Option<bool>,
    pub(super) cursor: Option<String>,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct Epic {
    pub(super) epic_id: Option<String>,
    pub(super) project: Option<String>,
    pub(super) issue_number: Option<i64>,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct Spec {
    pub(super) spec_id: Option<String>,
    pub(super) epic_id: Option<String>,
}
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(super) enum Status {
    Planned,
    InProgress,
    InReview,
    Blocked,
    Done,
}
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct Update {
    pub(super) epic_id: String,
    pub(super) expected_revision: i64,
    pub(super) status: Status,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct Comment {
    pub(super) epic_id: String,
    #[schemars(length(min = 1, max = 8000))]
    pub(super) body: String,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct Create {
    pub(super) project: String,
    #[schemars(length(min = 1, max = 256))]
    pub(super) title: String,
    pub(super) description: Option<String>,
    pub(super) assign_to_me: Option<bool>,
    pub(super) plan_id: Option<String>,
    /// Tag IDs from canon_list_tags.
    pub(super) tag_ids: Option<Vec<String>>,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct Propose {
    pub(super) spec_id: String,
    pub(super) base_revision: i64,
    pub(super) body: String,
    pub(super) summary: String,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct CreatePlan {
    pub(super) project: String,
    #[schemars(length(min = 1, max = 256))]
    pub(super) title: String,
    pub(super) description: Option<String>,
    /// Due date in YYYY-MM-DD format.
    pub(super) due_on: Option<String>,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct EditPlan {
    pub(super) plan_id: String,
    pub(super) expected_revision: i64,
    pub(super) title: Option<String>,
    pub(super) description: Option<String>,
    /// Due date in YYYY-MM-DD format; null clears it.
    #[serde(default, deserialize_with = "nullable")]
    pub(super) due_on: Option<Option<String>>,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct Edit {
    pub(super) epic_id: String,
    pub(super) expected_revision: i64,
    pub(super) title: Option<String>,
    pub(super) description: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub(super) plan_id: Option<Option<String>>,
    pub(super) before_id: Option<String>,
    /// Replaces the epic's tags with these tag IDs; [] removes all.
    pub(super) tag_ids: Option<Vec<String>>,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct Tags {
    pub(super) project: String,
}
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(super) enum TagColor {
    Gray,
    Red,
    Orange,
    Yellow,
    Green,
    Teal,
    Blue,
    Purple,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateTag {
    pub(super) project: String,
    #[schemars(length(min = 1, max = 32))]
    pub(super) name: String,
    pub(super) color: TagColor,
}
fn nullable<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}
