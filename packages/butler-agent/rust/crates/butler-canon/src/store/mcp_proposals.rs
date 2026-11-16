//! MCP spec drafts share the existing spec.edit resolver, without chat bindings.
use super::*;
use rusqlite::params;

pub fn spec(db: &Connection, id: &str) -> Result<Value> {
    let node = read_canon_spec(db, id)?;
    Ok(
        json!({"id":id,"title":node["concern_id"],"revision":node["revision"],"body":node["body"],"criteria":node.get("criteria").cloned().unwrap_or(json!([]))}),
    )
}
pub fn create(tx: &Transaction<'_>, ctx: &Context, id: &str, input: Value) -> Result<Value> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        base_revision: i64,
        body: String,
        summary: String,
    }
    let input: Input =
        serde_json::from_value(input).map_err(|_| Error::Invalid("invalid request fields"))?;
    if input.summary.trim().is_empty() {
        return Err(Error::Invalid("summary required"));
    }
    let node = read_canon_spec(tx, id)?;
    cas(&node, "revision", input.base_revision)?;
    let changes = json!([{"op":"spec.edit","id":id,"expected_revision":input.base_revision,"body":input.body}]);
    let proposal = insert(tx, ctx, text(&node, "scope_ref")?, &input.summary, &changes)?;
    activity::append(tx, ctx, id, "proposal_opened", &input.summary, None)?;
    api::outbox(
        tx,
        ctx,
        "spec_node",
        id,
        node["revision"].as_i64().unwrap_or_default(),
        &json!({"proposal_id":proposal}),
    )?;
    Ok(
        json!({"id":proposal,"spec_id":id,"summary":input.summary,"base_revision":input.base_revision,"state":"open"}),
    )
}
pub fn create_spec(tx: &Transaction<'_>, ctx: &Context, epic: &str, input: Value) -> Result<Value> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        body: String,
        summary: String,
    }
    let input: Input =
        serde_json::from_value(input).map_err(|_| Error::Invalid("invalid request fields"))?;
    if input.summary.trim().is_empty() {
        return Err(Error::Invalid("summary required"));
    }
    let work = read_work(tx, epic)?;
    let project = text(&work, "project_id")?;
    let changes = [json!({"op":"spec.create","id":epic,"body":input.body})];
    proposals::apply::validate(tx, ctx, project, &changes)?;
    let proposal = insert(tx, ctx, project, &input.summary, &json!(changes))?;
    activity::append(tx, ctx, epic, "proposal_opened", &input.summary, None)?;
    api::outbox(
        tx,
        ctx,
        "work",
        epic,
        work["revision"]
            .as_i64()
            .ok_or(Error::Invalid("revision"))?,
        &json!({"proposal_id":proposal}),
    )?;
    Ok(json!({"id":proposal,"epic_id":epic,"summary":input.summary,"state":"open"}))
}

fn insert(
    tx: &Transaction<'_>,
    ctx: &Context,
    project: &str,
    summary: &str,
    changes: &Value,
) -> Result<String> {
    let proposal =
        crate::work_ids::IdGenerator::global_next(crate::work_ids::IdKind::Proposal, ctx.now)?;
    tx.execute("INSERT INTO canon_proposals(id,project_id,summary,changes_json,state,created_at,source,actor_json) VALUES(?1,?2,?3,?4,'open',?5,'mcp',?6)",
        params![proposal,project,summary,changes.to_string(),proposals::iso(tx,ctx.now)?,ctx.actor.to_string()])?;
    Ok(proposal)
}

pub fn open(db: &Connection, epic: &str) -> Result<Value> {
    read_work(db, epic)?;
    let nodes = rows(
        db,
        "SELECT node_id FROM canon_spec_nodes WHERE epic_id=?1 AND scope_kind='project' AND visibility='canon'",
        [epic],
    )?;
    let mut result = Vec::new();
    for node in nodes {
        let id = text(&node, "node_id")?;
        let proposals = rows(db, api::sql::OPEN_MCP_SPEC, [id])?;
        if proposals.is_empty() {
            continue;
        }
        let node = read_canon_spec(db, id)?;
        for row in proposals {
            let changes: Vec<Value> = serde_json::from_str(text(&row, "changes_json")?)?;
            let change = changes
                .first()
                .ok_or(Error::Invalid("proposal changes required"))?;
            result.push(json!({"id":row["id"],"spec_id":id,"summary":row["summary"],"base_revision":change["expected_revision"],
                "current_body":node["body"],"proposed_body":change["body"],"actor":serde_json::from_str::<Value>(text(&row,"actor_json")?)?,"created_at":row["created_at"]}));
        }
    }
    for row in rows(db, api::sql::OPEN_MCP_SPEC, [epic])? {
        let changes: Vec<Value> = serde_json::from_str(text(&row, "changes_json")?)?;
        let change = changes
            .first()
            .ok_or(Error::Invalid("proposal changes required"))?;
        result.push(json!({"id":row["id"],"spec_id":null,"summary":row["summary"],"base_revision":null,
            "current_body":null,"proposed_body":change["body"],"actor":serde_json::from_str::<Value>(text(&row,"actor_json")?)?,"created_at":row["created_at"]}));
    }
    result.sort_by(|a, b| {
        b["created_at"]
            .as_str()
            .cmp(&a["created_at"].as_str())
            .then_with(|| b["id"].as_str().cmp(&a["id"].as_str()))
    });
    Ok(json!(result))
}
