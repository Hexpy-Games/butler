//! Real turn times and display labels for own and child subsession projections.
use super::*;
use butler_gateway::gateway::{AppSettingsFactsProvider, task_graph_model_label};
use serde_json::{Value, json};

pub(super) async fn enrich(
    conversations: &AgentConversationStore,
    settings: &super::super::runtime_ports::AppSettingsFactsAdapter,
    projection: &mut Value,
) -> Result<(), GatewayApplicationError> {
    let mut ids = Vec::new();
    for key in ["steward_children", "workers"] {
        for child in projection[key].as_array().into_iter().flatten() {
            if let Some(id) = child.pointer("/latest_turn/id").and_then(Value::as_str) {
                ids.push(id.to_owned());
            }
        }
    }
    if let Some(id) = projection
        .pointer("/latest_turn/id")
        .and_then(Value::as_str)
    {
        ids.push(id.to_owned());
    }
    let times = conversations
        .read_turn_lifecycles(ids)
        .await
        .map_err(GatewayApplicationError::internal_from)?;
    let facts = settings.snapshot()?;
    for key in ["steward_children", "workers"] {
        if let Some(children) = projection[key].as_array_mut() {
            for child in children {
                enrich_child(child, &times, &facts.native_settings);
            }
        }
    }
    enrich_child(projection, &times, &facts.native_settings);
    Ok(())
}
fn enrich_child(child: &mut Value, times: &Value, settings: &Value) {
    let lifecycle = child
        .pointer("/latest_turn/id")
        .and_then(Value::as_str)
        .map(|id| &times[id])
        .unwrap_or(&Value::Null);
    if let Some(id) = child.get("model_ref").and_then(Value::as_str) {
        let display = settings["model_display_names"][id]
            .as_str()
            .map(task_graph_model_label);
        child["model_display_name"] = json!(display);
    }
    if let Some(object) = child.as_object_mut() {
        object.remove("model_ref");
    }
    child["started_at"] = lifecycle["started_at"].clone();
    child["finished_at"] = lifecycle["finished_at"]
        .as_str()
        .or(child.pointer("/result/created_at").and_then(Value::as_str))
        .map_or(Value::Null, |time| json!(time));
    let updated = lifecycle["finished_at"]
        .as_str()
        .or(child.pointer("/result/created_at").and_then(Value::as_str))
        .or(lifecycle["started_at"].as_str())
        .map(str::to_owned);
    if let Some(updated) = updated {
        child["updated_at"] = json!(updated);
    }
    let updated = child["updated_at"].clone();
    for key in ["latest_turn", "active_turn"] {
        if let Some(turn) = child[key].as_object_mut() {
            if lifecycle["started_at"].is_string() {
                turn.insert("created_at".into(), lifecycle["started_at"].clone());
            }
            turn.insert("updated_at".into(), updated.clone());
        }
    }
}
