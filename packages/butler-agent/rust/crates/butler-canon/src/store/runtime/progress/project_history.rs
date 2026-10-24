use super::*;

/// Project revisions stay in Ledger. The indexed journal retains historical
/// stages, including the implicit transitions made by plan/review/disposition.
pub(super) fn read(db: &Connection, work: &Value, views: &ProjectViews) -> Result<Vec<Value>> {
    let id = text(work, "work_id")?;
    let mut calls = Vec::new();
    for turn in rows(db, Query::HistoryTurns.sql(), [id])? {
        calls.extend(rows(
            db,
            Query::HistoryCalls.sql(),
            [text(&turn, "turn_id")?],
        )?);
    }
    calls.sort_by(|a, b| a["rowid"].as_i64().cmp(&b["rowid"].as_i64()));
    let mut history = vec![
        json!({"revision":0,"stage":"conception","public_summary":"","created_at":work["created_at"]}),
    ];
    for call in calls {
        let result: Value = serde_json::from_str(text(&call, "result_json")?)?;
        let result = result.get("output").unwrap_or(&result);
        if result["ok"] != true || result["work"]["work_id"] != id {
            continue;
        }
        let args: Value = serde_json::from_str(text(&call, "arguments_json")?)?;
        // Reviews also checkpoint their entry stage before their resulting stage.
        let entry = match (call["tool_name"].as_str(), args["subject"].as_str()) {
            (Some("record_work_review"), Some("result")) => Some("review"),
            (Some("record_work_review"), Some("completion")) => Some("validation"),
            _ => None,
        };
        if let Some(stage) = entry {
            if history.last().is_none_or(|h| h["stage"] != stage) {
                history.push(json!({"revision":call["rowid"],"stage":stage,"public_summary":args["summary"],"created_at":call["finished_at"]}));
            }
        }
        let stage = args
            .get("stage")
            .unwrap_or(&result["work"]["current_stage"]);
        if stage.is_null()
            || (call["tool_name"] != "record_work_checkpoint"
                && history.last().is_some_and(|h| h["stage"] == *stage))
        {
            continue;
        }
        history.push(json!({"revision":call["rowid"],"stage":stage,"public_summary":args.get("public_summary").or_else(||args.get("summary")).cloned().unwrap_or(json!("")),"created_at":call["finished_at"]}));
    }
    if let Some(view) = views.get(id) {
        if let Some(stage) = view.get("currentStage") {
            if history.last().is_none_or(|h| h["stage"] != *stage) {
                history.push(json!({"revision":view["latestCheckpoint"]["revision"],"stage":stage,"public_summary":view["latestCheckpoint"]["publicSummary"],"created_at":view["updatedAt"]}));
            }
        }
    }
    Ok(history)
}
