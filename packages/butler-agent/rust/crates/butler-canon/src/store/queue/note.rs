//! The whole queue as one conversation's model reads it: read fresh, never by a tool.
use super::*;

/// `None` when the conversation has no queue. Human text stays in `untrusted_content`.
pub fn note(db: &Connection, session: &str) -> Result<Option<Value>> {
    let items = items(db, session)?;
    if items.is_empty() {
        return Ok(None);
    }
    let mut untrusted = serde_json::Map::new();
    let mut plans = serde_json::Map::new();
    let mut output = Vec::new();
    for (id, chain) in chains(&items)? {
        let plan = items
            .iter()
            .find(|i| i["chain_id"] == id.as_str())
            .and_then(|i| i["plan_id"].as_str());
        if let Some(plan) = plan {
            plans.insert(plan.to_owned(), read_plan(db, plan)?["title"].clone());
        }
        let mut steps = Vec::new();
        for step in chain.steps {
            let mut entries = Vec::new();
            for epic in step.tasks {
                let item = items
                    .iter()
                    .find(|i| i["epic_id"] == epic.as_str())
                    .ok_or(Error::NotFound)?;
                let mut content = json!({"title":item["title"]});
                if item["state"] == "done"
                    && let Some(work) = item["btcc_work_id"].as_str()
                    && let Some(result) = runtime::closing_summary(db, work)?
                {
                    content["result"] = json!(result);
                }
                untrusted.insert(epic.as_str().to_owned(), content);
                entries.push(json!({
                    "epic_id": epic.as_str(),
                    "state": item["state"],
                    "hold_reason": item["hold_reason"],
                    "held_by_epic_id": item["held_by_epic_id"],
                    "decision": item["decision"],
                }));
            }
            steps.push(json!({"index":step.index,"items":entries}));
        }
        output.push(json!({"chain_id":id,"plan_id":plan,"steps":steps}));
    }
    if !plans.is_empty() {
        untrusted.insert("plans".into(), json!(plans));
    }
    Ok(Some(
        json!({"revision":revision(db,session)?,"chains":output,"untrusted_content":untrusted}),
    ))
}
