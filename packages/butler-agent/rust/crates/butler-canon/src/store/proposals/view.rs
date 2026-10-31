//! Keyed live projection for transcript cards and independent ask consumers.
use super::*;

pub fn detail(db: &Connection, id: &str, language: &str) -> Result<Value> {
    let row = get(db, id)?;
    let document = &row["document"];
    let mut changes = document["changes"]
        .as_array()
        .cloned()
        .ok_or(Error::Invalid("changes required"))?;
    if row["state"] == "applied" {
        for (change, result) in changes.iter_mut().zip(
            document["result"]["applied"]
                .as_array()
                .into_iter()
                .flatten(),
        ) {
            if result["id"].is_string() {
                change["id"] = result["id"].clone();
            }
        }
    }
    for change in &mut changes {
        if change["op"] == "epic.move" {
            let current = optional_work(db, text(change, "id")?)?.unwrap_or(Value::Null);
            change["current_plan_title"] = current["plan_id"]
                .as_str()
                .map(|id| read_plan(db, id).map(|p| p["title"].clone()))
                .transpose()?
                .unwrap_or(Value::Null);
            change["destination_plan_title"] = change["plan_id"]
                .as_str()
                .map(|id| read_plan(db, id).map(|p| p["title"].clone()))
                .transpose()?
                .unwrap_or(Value::Null);
        }
        if let Some(ids) = change["work_ids"].as_array() {
            change["order_titles"] = json!(
                ids.iter()
                    .map(|id| optional_work(
                        db,
                        id.as_str().ok_or(Error::Invalid("work id required"))?
                    )
                    .map(|w| w.map(|w| w["title"].clone()).unwrap_or_else(|| id.clone())))
                    .collect::<Result<Vec<_>>>()?
            );
        }
    }
    let mut epics = Vec::new();
    for change in changes.iter().filter(|c| {
        matches!(
            c["op"].as_str(),
            Some("epic.create" | "epic.edit" | "epic.move")
        )
    }) {
        epics.push(epic(db, change)?);
    }
    let plan_id = changes.iter().find_map(|c| c["plan_id"].as_str());
    let plan = plan_id
        .map(|id| read_plan(db, id).map(|p| json!({"id":id,"title":p["title"]})))
        .transpose()?;
    Ok(
        json!({"proposal_id":row["id"],"session_id":row["session_id"],"state":row["state"],
        "summary":row["summary"],"target_label":super::target::label(document, &changes, plan.as_ref(), language),
        "project":if row["project_id"].is_null() || (row["state"]!="applied" && document["new_name"].is_string()){json!({"new_name":document["new_name"].as_str().unwrap_or_default()})}else{json!({"id":row["project_id"],"name":""})},
        "plan":plan,"changes":changes,"epics":epics,"created_at":row["created_at"],
        "resolved_at":row["resolved_at"],"resolved_by":row["resolved_by"]}),
    )
}
fn epic(db: &Connection, change: &Value) -> Result<Value> {
    let old = change["id"]
        .as_str()
        .map(|id| optional_work(db, id))
        .transpose()?
        .flatten();
    let mut tags = Vec::new();
    if let Some(items) = change["tags"].as_array() {
        for tag in items {
            if tag["new"].is_object() {
                let mut value = tag["new"].clone();
                value["new"] = json!(true);
                tags.push(value);
            } else {
                let tag = one(db, super::super::api::sql::TAG, [text(tag, "tag_id")?])?;
                tags.push(json!({"id":tag["id"],"name":tag["name"],"color":tag["color"]}));
            }
        }
    } else if let Some(old) = &old {
        tags = rows(db, super::super::api::sql::EPIC_TAGS, [text(old, "id")?])?
            .into_iter()
            .map(|tag| json!({"id":tag["id"],"name":tag["name"],"color":tag["color"]}))
            .collect();
    }
    let description = change
        .get("description")
        .or_else(|| old.as_ref().and_then(|o| o.get("description")))
        .cloned()
        .unwrap_or(json!(""));
    let attachments =
        super::super::attachment_references_lenient(description.as_str().unwrap_or_default())
            .into_iter()
            .map(|id| json!({"file_id":id}))
            .collect::<Vec<_>>();
    Ok(
        json!({"title":change.get("title").or_else(||old.as_ref().and_then(|o|o.get("title"))),
        "description":description,
        "tags":tags,"attachments":attachments}),
    )
}
pub fn open(
    db: &Connection,
    session: Option<&str>,
    limit: usize,
    before: Option<&str>,
    language: &str,
) -> Result<Vec<Value>> {
    let limit = i64::try_from(limit).map_err(|_| Error::Invalid("limit too large"))?;
    let records = if let Some(session) = session {
        rows(db, queries::OPEN_SESSION, [session])?
    } else if let Some((time, id)) = before.and_then(|s| s.split_once('|')) {
        rows(db, queries::OPEN_BEFORE, params![time, id, limit])?
    } else {
        rows(db, queries::OPEN_PAGE, [limit])?
    };
    records.into_iter().map(|r| {
        let detail = detail(db,text(&r,"id")?,language)?;
        Ok(json!({"ask_id":format!("canon:{}",text(&r,"id")?),"kind":"canon_proposal",
            "session_id":r["session_id"],"source_session_id":r["session_id"],"source_turn_id":r["source_turn_id"],
            "source_message_id":null,"source_call_id":r["source_call_id"],"deferred":false,
            "waiting_since":r["created_at"],"title":r["summary"],"summary":r["summary"],"target_label":detail["target_label"],
            "blocking":false,"state":"open","created_at":r["created_at"],"actions":["accept","decline","dismiss"]}))
    }).collect()
}

fn optional_work(db: &Connection, id: &str) -> Result<Option<Value>> {
    match read_work(db, id) {
        Ok(row) => Ok(Some(row)),
        Err(Error::NotFound) => Ok(None),
        Err(error) => Err(error),
    }
}
