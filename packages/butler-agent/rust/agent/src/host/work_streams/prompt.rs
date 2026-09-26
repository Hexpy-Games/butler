use serde_json::{Value, json};

use super::{storage::Store, support::*};
use crate::btcc::BtccError;

impl Store {
    pub(super) fn prompt_context(
        &mut self,
        session_id: &str,
        project_id: Option<&str>,
    ) -> Result<Value, BtccError> {
        self.recover_pending()?;
        let records = self
            .records()?
            .into_iter()
            .filter(|record| string(record, "owner_session_id").as_deref() == Some(session_id))
            .filter(|record| {
                project_id
                    .is_none_or(|project| string(record, "project_id").as_deref() == Some(project))
            })
            .collect::<Vec<_>>();
        let selected = records
            .iter()
            .find(|record| active(record, None))
            .or_else(|| {
                records.iter().find(|record| {
                    matches!(
                        string(record, "state").as_deref(),
                        Some("paused" | "waiting_user" | "failed" | "recoverable")
                    )
                })
            });
        let Some(stream) = selected else {
            return Ok(json!({"text":"","worker_task_ids":[]}));
        };
        Ok(json!({
            "text":render(&self.root, stream)?,
            "worker_task_ids":array(Some(stream), "linked_worker_task_ids")
        }))
    }
}

fn render(root: &std::path::Path, stream: &Value) -> Result<String, BtccError> {
    let id = string(stream, "id").ok_or_else(|| error("work_stream_record_invalid"))?;
    let title = string(stream, "title").unwrap_or_else(|| "Butler work stream".into());
    let state = string(stream, "state").ok_or_else(|| error("work_stream_record_invalid"))?;
    let mut lines = vec![
        "## Active Work State".into(),
        format!("WorkStream ID: {id}"),
        format!("WorkStream Title: {title}"),
        format!("WorkStream State: {state}"),
        format!(
            "WorkStream Phase: {}",
            string(stream, "current_phase").unwrap_or_else(|| "none".into())
        ),
    ];
    if let Some(step) = string(stream, "active_step_id") {
        lines.push(format!("Active Step ID: {step}"));
    }
    if let Some(note) = string(stream, "status_note").filter(|note| show_note(&state, note)) {
        lines.push(format!("Status Note: {note}"));
    }
    if let Some(list_id) = string(stream, "todo_list_id")
        && let Some(todo) = read_object(&root.join("todos").join(format!("{list_id}.json")))?
    {
        let items = todo
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        lines.push(format!("Todo List ID: {list_id}"));
        if let Some(current) = items
            .iter()
            .find(|item| string(item, "status").as_deref() == Some("in_progress"))
            .and_then(|item| string(item, "active_form"))
        {
            lines.push(format!("Current Todo: {current}"));
        }
        let resume = resume_todo(&items, string(stream, "active_step_id").as_deref());
        if let Some(item) = resume {
            lines.push(format!("Resume From Todo: {}", todo_line(item)));
        }
        let remaining = items
            .iter()
            .filter(|item| {
                !matches!(
                    string(item, "status").as_deref(),
                    Some("completed" | "cancelled")
                )
            })
            .take(8)
            .map(todo_line)
            .collect::<Vec<_>>();
        if !remaining.is_empty() {
            lines.push("Open Todo Items:".into());
            lines.extend(remaining.iter().map(|item| format!("- {item}")));
        }
        if resumable(&state) && !remaining.is_empty() {
            lines.push("Continuation Contract:".into());
            lines.push(format!(
                "- Primary Target: existing WorkStream {id} and Todo List {list_id}."
            ));
            if let Some(item) = resume {
                lines.push(format!("- Next Step: {}", todo_line(item)));
            }
            lines.push("- If the current user input asks to continue or resume this session's work, update this existing todo list instead of creating a new turn-scoped checklist.".into());
            lines.push("- If the next step is pending because a previous turn became recoverable, restore that step to in_progress and execute it before broad validation, review, or replanning.".into());
            lines.push("- Do not replace open planning or execution steps with a new inspection/review/validation plan; review only after the existing WorkStream reaches its review or reporting phase.".into());
        }
    }
    let planned = array(Some(stream), "linked_planned_task_ids");
    if let Some(ids) = planned.as_array().filter(|ids| !ids.is_empty()) {
        lines.push(format!(
            "Linked Planned Tasks: {}",
            ids.iter()
                .filter_map(Value::as_str)
                .take(12)
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    let orchestrations = array(Some(stream), "linked_orchestration_ids");
    if let Some(ids) = orchestrations.as_array().filter(|ids| !ids.is_empty()) {
        lines.push(format!(
            "Linked Orchestrations: {}",
            ids.iter()
                .filter_map(Value::as_str)
                .take(12)
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    Ok(lines.join("\n"))
}

fn resume_todo<'a>(items: &'a [Value], active_step: Option<&str>) -> Option<&'a Value> {
    let selected = active_step.and_then(|id| {
        items.iter().find(|item| {
            string(item, "id").as_deref() == Some(id)
                && !matches!(
                    string(item, "status").as_deref(),
                    Some("completed" | "cancelled")
                )
        })
    });
    selected
        .or_else(|| {
            items
                .iter()
                .find(|item| string(item, "status").as_deref() == Some("in_progress"))
        })
        .or_else(|| {
            items
                .iter()
                .find(|item| string(item, "status").as_deref() == Some("pending"))
        })
}

fn todo_line(item: &Value) -> String {
    format!(
        "{}:{}:{}:{}",
        string(item, "id").unwrap_or_default(),
        string(item, "status").unwrap_or_default(),
        string(item, "phase").unwrap_or_else(|| "none".into()),
        string(item, "active_form").unwrap_or_default()
    )
}

fn resumable(state: &str) -> bool {
    ACTIVE.contains(&state) || matches!(state, "waiting_user" | "paused" | "recoverable")
}

fn show_note(state: &str, note: &str) -> bool {
    if matches!(state, "paused" | "waiting_user" | "failed" | "recoverable") {
        return true;
    }
    let normalized = note.to_lowercase();
    ![
        "final delivery blocked",
        "previous answer",
        "non-deliverable",
        "interrupted before final delivery",
        "active direct work stream is not deliverable",
    ]
    .iter()
    .any(|value| normalized.contains(value))
}
