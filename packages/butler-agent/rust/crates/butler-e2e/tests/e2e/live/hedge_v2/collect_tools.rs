//! Ordered parent/child operation events, including command outputs.
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::HarnessError;
use rusqlite::Connection;
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub(super) fn tools(db: &Connection) -> Result<Vec<Value>, HarnessError> {
    let mut args = BTreeMap::new();
    let mut stmt = db.prepare(
        "SELECT turn_id,normalized_response_json FROM btcc_model_round_acceptances ORDER BY rowid",
    )?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (turn, raw) = row?;
        arguments(&serde_json::from_str(&raw)?, &turn, &mut args);
    }
    let mut stmt =
        db.prepare("SELECT turn_id,event_json FROM btcc_progress_events ORDER BY rowid")?;
    let mut order = Vec::new();
    let mut rows = BTreeMap::new();
    let mut chunks = BTreeMap::<(String, String, String), Vec<u8>>::new();
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (turn, raw) = row?;
        let event: Value = serde_json::from_str(&raw)?;
        let p = &event["payload"];
        if event["kind"] == "operation.output.chunk" {
            let key = (
                turn,
                p["requestId"].as_str().unwrap_or("").into(),
                p["resultId"].as_str().unwrap_or("").into(),
            );
            if let Some(data) = p["contentBase64"]
                .as_str()
                .and_then(|s| STANDARD.decode(s).ok())
            {
                chunks.entry(key).or_default().extend(data);
            }
        } else if p["activityKind"] == "used_tool" {
            let key = (turn, p["toolCallId"].as_str().unwrap_or("").to_owned());
            if !rows.contains_key(&key) {
                order.push(key.clone());
            }
            let stored = rows.entry(key).or_insert_with(|| json!({}));
            stored
                .as_object_mut()
                .unwrap()
                .extend(p.as_object().unwrap().clone());
            stored["event_kind"] = event["kind"].clone();
        }
    }
    Ok(order.into_iter().filter_map(|key| {
        let p = rows.get(&key)?;
        let output = chunks.get(&(key.0.clone(),key.1.clone(),p["resultId"].as_str().unwrap_or("").into()))
            .map(|b|String::from_utf8_lossy(b).into_owned()).unwrap_or_else(||"(output not available)".into());
        let value: Value = serde_json::from_str(&output).unwrap_or(Value::Null);
        let result = value.get("output").unwrap_or(&value);
        let ok = p["operationStatus"] == "completed" && result["ok"] != false
            && !matches!(result["status"].as_str(),Some("refused"|"failed"))
            && result["exit_code"].as_i64().is_none_or(|code|code==0);
        let invocation = args.get(&key).and_then(|raw| serde_json::from_str::<Value>(raw).ok());
        let catalog_id = invocation.as_ref().and_then(|v| v["id"].as_str());
        Some(json!({"name":p["toolName"],"catalog_id":catalog_id,"ok":ok,"output_id":result["output_id"],
            "turn_id":key.0,"call_id":key.1,"result_id":p["resultId"],
            "args":args.get(&key).cloned().unwrap_or_default(),
            "output":output.chars().take(2000).collect::<String>()}))
    }).collect())
}
fn arguments(value: &Value, turn: &str, out: &mut BTreeMap<(String, String), String>) {
    if let (Some(id), Some(args)) = (value["id"].as_str(), value.get("arguments")) {
        out.insert((turn.into(), id.into()), args.to_string());
    }
    match value {
        Value::Object(fields) => {
            for v in fields.values() {
                arguments(v, turn, out);
            }
        }
        Value::Array(values) => {
            for v in values {
                arguments(v, turn, out);
            }
        }
        _ => {}
    }
}
