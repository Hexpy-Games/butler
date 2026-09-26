//! App outbound progress conversion and durable public progress append.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use super::{copy_string, short_text, text, token};
use crate::gateway::application::{
    events::{self, EventSubscribers},
    service,
    storage::AppStorageError,
};

pub(super) struct ProgressInput<'a> {
    pub db: &'a Connection,
    pub subscribers: &'a EventSubscribers,
    pub chat: &'a str,
    pub turn: &'a str,
    pub action: &'a str,
    pub kind: &'a str,
    pub metadata: &'a Map<String, Value>,
    pub message: &'a Map<String, Value>,
    pub timestamp: &'a str,
    pub now: &'a str,
    pub event_id: &'a str,
}

pub(super) fn project_progress(input: ProgressInput<'_>) -> Result<(), AppStorageError> {
    let label = if input.kind == "intermediate" {
        text(input.message.get("text"))
    } else {
        text(input.metadata.get("safeLabel"))
    }
    .unwrap_or_else(|| "Working".to_owned());
    let row = progress_row(&input, &label)?;
    let Some(row) = row else { return Ok(()) };
    let runtime = service::map(json!({
        "id":input.event_id,"sessionId":input.chat,"turnId":input.turn,
        "kind":"tool.progress","visibility":"public",
        "payload":{"safeLabel":short_text(&label,180)},"createdAt":input.timestamp
    }))?;
    events::append(
        input.db,
        input.subscribers,
        "agent.turn_event",
        Some(input.turn),
        service::map(json!({
            "session_id":input.chat,"turn_id":input.turn,"event":runtime
        }))?,
        input.now,
    )?;
    append_progress(ProgressAppend {
        db: input.db,
        subscribers: input.subscribers,
        chat: input.chat,
        turn: input.turn,
        row,
        event_type: "progress.summary",
        source_event: None,
        now: input.now,
    })
}

fn progress_row(
    input: &ProgressInput<'_>,
    label: &str,
) -> Result<Option<Map<String, Value>>, AppStorageError> {
    if input.kind == "intermediate" && label.is_empty() {
        return Ok(None);
    }
    let before_tool =
        input.metadata.get("phase").and_then(Value::as_str) == Some("before_tool_execution");
    let activity_kind = token(input.metadata.get("activityKind"));
    let row_kind = match input.kind {
        "todo_progress" => "todo",
        "intermediate" if before_tool => "message",
        "intermediate" => "thinking",
        _ => activity_kind.as_deref().unwrap_or("used_tool"),
    };
    let row_id = if input.kind == "todo_progress" {
        token(input.metadata.get("todoId")).unwrap_or_else(|| input.action.to_owned())
    } else {
        input.action.to_owned()
    };
    let mut row = service::map(json!({
        "id":row_id,"kind":row_kind,
        "state":token(input.metadata.get("state")).unwrap_or_else(|| {
            if input.kind == "todo_progress" {"thinking".into()} else {"running".into()}
        }),
        "safe_label":short_text(label,180),"created_at":input.timestamp
    }))?;
    basic_fields(&mut row, input.metadata);
    if input.kind == "todo_progress" {
        todo_fields(&mut row, input.metadata)?;
    }
    if input.kind == "intermediate" && before_tool {
        row.insert(
            "work_block_id".into(),
            token(input.metadata.get("workBlockId"))
                .unwrap_or_else(|| input.action.to_owned())
                .into(),
        );
    }
    Ok(Some(row))
}

fn basic_fields(row: &mut Map<String, Value>, source: &Map<String, Value>) {
    copy_string(source, row, "toolName", "safe_tool_name", 180);
    copy_string(source, row, "inputLabel", "safe_input_label", 180);
    copy_string(source, row, "toolCallId", "tool_call_id", 96);
    copy_string(source, row, "workBlockId", "work_block_id", 96);
    copy_string(source, row, "workBlockLabel", "work_block_label", 180);
    copy_string(source, row, "decisionTitle", "work_decision_title", 180);
    copy_string(source, row, "decisionSummary", "work_decision_summary", 180);
    copy_string(
        source,
        row,
        "decisionRationale",
        "work_decision_rationale",
        180,
    );
    copy_string(
        source,
        row,
        "decisionNextStep",
        "work_decision_next_step",
        180,
    );
    copy_string(source, row, "decisionSource", "work_decision_source", 180);
    copy_text_list(
        source,
        row,
        "decisionEvidenceRefs",
        "work_decision_evidence_refs",
        6,
    );
    copy_detail_rows(source, row, "detailRows");
}

fn todo_fields(
    row: &mut Map<String, Value>,
    source: &Map<String, Value>,
) -> Result<(), AppStorageError> {
    copy_string(source, row, "todoId", "safe_input_label", 180);
    if let Some(order) = non_negative_integer(source.get("safeOrder")) {
        row.insert("safe_order".into(), order.into());
    }
    let Some(phase) = text(source.get("phase")) else {
        return Ok(());
    };
    let value = match phase.to_ascii_lowercase().as_str() {
        "orientation" => "구상",
        "planning" => "계획",
        "execution" => "실행",
        "review" => "검토",
        "consolidation" => "정리",
        "reporting" => "보고",
        _ => &phase,
    };
    row.insert(
        "safe_detail_rows".into(),
        json!([{
            "id":"phase","kind":"phase","safe_label":"Phase",
            "safe_value":short_text(value,180),
            "state":token(source.get("state")).unwrap_or_else(||"thinking".into())
        }]),
    );
    Ok(())
}

fn copy_text_list(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    from: &str,
    to: &str,
    limit: usize,
) {
    let values = source
        .get(from)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| text(Some(value)))
        .map(|value| short_text(&value, 180))
        .take(limit)
        .map(Value::String)
        .collect::<Vec<_>>();
    if !values.is_empty() {
        target.insert(to.into(), Value::Array(values));
    }
}

fn copy_detail_rows(source: &Map<String, Value>, target: &mut Map<String, Value>, from: &str) {
    let Some(details) = source.get(from).and_then(Value::as_array) else {
        return;
    };
    let rows = details.iter().filter_map(Value::as_object).take(20).enumerate()
        .filter_map(|(index, detail)| {
            let id = token(detail.get("id")).unwrap_or_else(||format!("detail-{}",index+1));
            let mut row = service::map(json!({
                "id":id,"safe_label":text(detail.get("safe_label").or_else(||detail.get("safeLabel")))
                    .map(|value|short_text(&value,180)).unwrap_or_else(||"Detail".into())
            })).ok()?;
            copy_string(detail,&mut row,"kind","kind",96);
            copy_string(detail,&mut row,"safe_value","safe_value",180);
            copy_string(detail,&mut row,"safeValue","safe_value",180);
            copy_string(detail,&mut row,"state","state",96);
            Some(Value::Object(row))
        }).collect::<Vec<_>>();
    if !rows.is_empty() {
        target.insert("safe_detail_rows".into(), Value::Array(rows));
    }
}

fn non_negative_integer(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) if !text.trim().is_empty() => text.trim().parse().ok(),
        _ => None,
    }
    .filter(|number| number.is_finite() && *number >= 0.0)
    .map(|number| number.round() as u64)
}

pub(super) struct ProgressAppend<'a> {
    pub db: &'a Connection,
    pub subscribers: &'a EventSubscribers,
    pub chat: &'a str,
    pub turn: &'a str,
    pub row: Map<String, Value>,
    pub event_type: &'a str,
    pub source_event: Option<&'a str>,
    pub now: &'a str,
}

pub(super) fn append_progress(input: ProgressAppend<'_>) -> Result<(), AppStorageError> {
    let encoded = serde_json::to_string(&input.row)
        .map_err(|e| AppStorageError::new("app_projection_json_invalid", e.to_string()))?;
    let exists = input
        .db
        .query_row(
            "SELECT 1 FROM app_progress_row_identities WHERE turn_id=?1 AND row_json=?2",
            params![input.turn, encoded],
            |_| Ok(()),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .is_some();
    if exists {
        return Ok(());
    }
    let label = input
        .row
        .get("safe_label")
        .and_then(Value::as_str)
        .unwrap_or("Working");
    input.db.execute("UPDATE turns SET safe_status_label=?1,updated_at=?2 WHERE id=?3 AND state NOT IN ('delivered','failed','cancelled','runtime_fault')",params![label,input.now,input.turn]).map_err(AppStorageError::sqlite)?;
    let mut payload =
        service::map(json!({"session_id":input.chat,"turn_id":input.turn,"row":input.row}))?;
    if let Some(id) = input.source_event {
        payload.insert("event_id".into(), id.into());
    }
    events::append(
        input.db,
        input.subscribers,
        input.event_type,
        Some(input.turn),
        payload,
        input.now,
    )?;
    input
        .db
        .execute(
            "INSERT OR IGNORE INTO app_progress_row_identities(turn_id,row_json) VALUES(?1,?2)",
            params![input.turn, encoded],
        )
        .map_err(AppStorageError::sqlite)?;
    Ok(())
}
