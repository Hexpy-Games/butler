use super::*;

pub fn view(db: &Connection, session: &str, views: &runtime::ProjectViews) -> Result<Value> {
    let items = items(db, session)?;
    let mut counts = json!({"running":0,"failed":0,"held":0,"waiting":0});
    let mut output = Vec::new();
    for (id, chain) in chains(&items)? {
        let mut steps = Vec::new();
        for step in chain.steps {
            let mut output_items = Vec::new();
            for epic in step.tasks {
                let item = items
                    .iter()
                    .find(|i| i["epic_id"] == epic.as_str())
                    .ok_or(Error::NotFound)?;
                let state = text(item, "state")?;
                let count = if state == "running" && !item["hold_reason"].is_null() {
                    "failed"
                } else {
                    state
                };
                if let Some(n) = counts[count].as_u64() {
                    counts[count] = json!(n + 1);
                }
                let mut entry = json!({"epic_id":epic,"title":item["title"],"canon_status":item["canon_status"],"state":state,"progress":runtime::progress(db,epic.as_str(),views)?});
                for key in ["hold_reason", "held_by_epic_id"] {
                    if !item[key].is_null() {
                        entry[key] = item[key].clone();
                    }
                }
                output_items.push(entry);
            }
            steps.push(json!({"index":step.index,"items":output_items}));
        }
        let origin = items
            .iter()
            .find(|i| i["chain_id"] == id)
            .ok_or(Error::NotFound)?["origin"]
            .clone();
        output.push(json!({"chain_id":id,"origin":origin,"steps":steps}));
    }
    let plan = items
        .first()
        .and_then(|i| i["plan_id"].as_str())
        .map(|id| read_plan(db, id))
        .transpose()?
        .map(|p| json!({"id":p["id"],"title":p["title"]}));
    Ok(
        json!({"session_id":session,"graph_revision":revision(db,session)?,"plan":plan,"counts":counts,"chains":output}),
    )
}
