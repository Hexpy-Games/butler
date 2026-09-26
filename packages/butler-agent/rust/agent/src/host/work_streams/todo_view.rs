//! Source TodoList view through the existing WorkStream/todo owner.

use serde_json::{Value, json};

use super::{WorkStreamScope, storage::Store, support::*};
use crate::btcc::BtccError;

impl Store {
    pub(super) fn view_todo(
        &mut self,
        scope: WorkStreamScope,
        input: Value,
    ) -> Result<Value, BtccError> {
        self.recover_pending()?;
        let requested = input.get("list_id");
        let explicit = requested
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty() && *id != "main");
        let continuation = self
            .records()?
            .into_iter()
            .filter(|record| {
                string(record, "owner_session_id").as_deref() == Some(&scope.session_id)
            })
            .filter(|record| {
                scope.project_id.as_ref().is_none_or(|project| {
                    string(record, "project_id").as_deref() == Some(project.as_str())
                })
            })
            .filter(|record| {
                string(record, "state").as_deref().is_some_and(|state| {
                    ACTIVE.contains(&state)
                        || matches!(state, "waiting_user" | "paused" | "recoverable")
                })
            })
            .filter(|record| string(record, "todo_list_id").as_deref() != Some("runtime-semantic"))
            .filter_map(|record| {
                Some((
                    string(&record, "updated_at")?,
                    string(&record, "todo_list_id")?,
                ))
            })
            .max_by(|left, right| left.0.cmp(&right.0))
            .map(|(_, id)| id);
        let id = match (explicit, continuation.as_deref()) {
            (Some(id), Some(current)) if id != current => id.to_owned(),
            (Some(_), Some(current)) | (None, Some(current)) => current.to_owned(),
            (Some(id), None) => id.to_owned(),
            (None, None) => list_id(requested, &scope.turn_id)?,
        };
        safe_id(&id, 80)?;
        let record = read_object(&self.root.join("todos").join(format!("{id}.json")))?
            .unwrap_or_else(|| {
                json!({"version":1,"list_id":id,"title":null,
                "created_at":"1970-01-01T00:00:00.000Z",
                "updated_at":"1970-01-01T00:00:00.000Z","items":[]})
            });
        let all_items = record
            .get("items")
            .and_then(Value::as_array)
            .ok_or_else(|| error("todo_record_invalid"))?;
        let include_completed =
            input.get("include_completed").and_then(Value::as_bool) == Some(true);
        let items = all_items
            .iter()
            .filter(|item| {
                include_completed
                    || !matches!(
                        string(item, "status").as_deref(),
                        Some("completed" | "cancelled")
                    )
            })
            .cloned()
            .collect::<Vec<_>>();
        Ok(json!({"ok":true,"list_id":id,"title":record["title"],
            "updated_at":record["updated_at"],"items":items,"progress":progress(all_items)}))
    }
}
