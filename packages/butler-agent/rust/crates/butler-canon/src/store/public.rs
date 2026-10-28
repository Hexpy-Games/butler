//! Explicit canon-only wire models shared by the paged API and MCP projection.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Plan {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub revision: i64,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct PlanRef {
    pub id: String,
    pub title: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Criterion {
    pub criterion_id: String,
    pub part_id: String,
    pub text: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Spec {
    pub id: String,
    pub title: String,
    pub revision: i64,
    pub criteria: Vec<Criterion>,
    pub children: Vec<Spec>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Actor {
    pub person: Option<String>,
    pub via: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Activity {
    pub seq: i64,
    pub entity_id: String,
    pub kind: String,
    pub summary: String,
    pub body: Option<String>,
    pub actor: Actor,
    pub at: i64,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Epic {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub assignee: Option<String>,
    pub plan: Option<PlanRef>,
    pub order: Option<String>,
    pub revision: i64,
    pub tags: Vec<Tag>,
    pub specs: Vec<Spec>,
    pub activity: Vec<Activity>,
    pub activity_before: Option<i64>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct SpecBody {
    pub id: String,
    pub title: String,
    pub revision: i64,
    pub body: Option<String>,
    pub criteria: Vec<Criterion>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct EpicSummary {
    pub id: String,
    pub title: String,
    pub status: String,
    pub revision: i64,
    pub plan: Option<PlanRef>,
    pub tags: Vec<Tag>,
    pub assignee: Option<String>,
    pub updated_at: i64,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Page {
    pub plans: Vec<Plan>,
    pub epics: Vec<EpicSummary>,
    pub cursor: Option<String>,
}

pub fn epic(db: &Connection, id: &str) -> Result<Epic> {
    project_epic(&api::epic_only(db, id)?, db)
}
pub fn project_epic(row: &Value, db: &Connection) -> Result<Epic> {
    let plan = row["plan_id"]
        .as_str()
        .map(|id| {
            read_plan(db, id).and_then(|r| {
                Ok(PlanRef {
                    id: id.into(),
                    title: text(&r, "title")?.into(),
                })
            })
        })
        .transpose()?;
    let mut specs = specs(&row["specs"])?;
    specs.sort_by_key(|s| {
        (
            row["spec_node_id"].as_str() != Some(s.id.as_str()),
            s.id.clone(),
        )
    });
    let history = activity::mcp_page(db, text(row, "id")?, None)?;
    Ok(Epic {
        id: text(row, "id")?.into(),
        project_id: text(row, "project_id")?.into(),
        title: text(row, "title")?.into(),
        description: text(row, "description")?.into(),
        status: text(row, "canon_status")?.into(),
        assignee: row["assignee"].as_str().map(str::to_owned),
        plan,
        order: row["plan_rank"].as_str().map(str::to_owned),
        revision: row["revision"].as_i64().ok_or(Error::Invalid("revision"))?,
        tags: serde_json::from_value(row["tags"].clone())?,
        specs,
        activity: serde_json::from_value(history["activity"].clone())?,
        activity_before: history["activity_before"].as_i64(),
    })
}
fn specs(nodes: &Value) -> Result<Vec<Spec>> {
    nodes
        .as_array()
        .into_iter()
        .flatten()
        .filter(|n| n["scope_kind"] == "project" && n["visibility"] == "canon")
        .map(|n| {
            Ok(Spec {
                id: text(n, "node_id")?.into(),
                title: text(n, "concern_id")?.into(),
                revision: n["revision"].as_i64().ok_or(Error::Invalid("revision"))?,
                criteria: serde_json::from_value(n["criteria"].clone())?,
                children: specs(&n["children"])?,
            })
        })
        .collect()
}
