use std::{fs, path::Path};

use serde_json::{Value, json};

use super::{storage::Store, support::*};
use crate::btcc::BtccError;

impl Store {
    pub(super) fn recover_pending(&self) -> Result<(), BtccError> {
        self.recover_directory("workstream-plan-transactions", RecoveryKind::Plan)?;
        self.recover_directory("workstream-reporting-transactions", RecoveryKind::Reporting)
    }

    fn recover_directory(&self, name: &str, kind: RecoveryKind) -> Result<(), BtccError> {
        let directory = self.root.join(name);
        let Ok(entries) = fs::read_dir(&directory) else {
            return Ok(());
        };
        let mut paths = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
            .collect::<Vec<_>>();
        paths.sort();
        for path in paths {
            let Some(journal) = read_object(&path)? else {
                continue;
            };
            if string(&journal, "state").as_deref() == Some("prepared") {
                self.recover_journal(&path, journal, kind)?;
            }
        }
        Ok(())
    }

    fn recover_journal(
        &self,
        path: &Path,
        journal: Value,
        kind: RecoveryKind,
    ) -> Result<(), BtccError> {
        let before = object(&journal, "before_workstream")?;
        let after = object(&journal, "after_workstream")?;
        let id = string(&before, "id").ok_or_else(|| error("work_stream_recovery_invalid"))?;
        safe_id(&id, 120)?;
        self.with_lock(&id, kind.operation(), |current| {
            let compatible =
                self.recovery_compatible(&journal, current.as_ref(), &before, &after, kind)?;
            if !compatible {
                return mark(path, journal, "conflict");
            }
            if current.as_ref() == Some(&before) {
                let before_generation = integer(&before, "record_generation").unwrap_or(1);
                if integer(&after, "record_generation") != Some(before_generation + 1) {
                    return Err(error("work_stream_recovery_invalid"));
                }
                write_atomic(
                    &self.root.join("work-streams").join(format!("{id}.json")),
                    &after,
                )?;
            }
            self.write_recovered_todo(&journal, kind)?;
            if kind == RecoveryKind::Plan {
                let receipt = object(&journal, "receipt")?;
                let receipt_id = string(&receipt, "receipt_id")
                    .ok_or_else(|| error("work_stream_recovery_invalid"))?;
                safe_id(&receipt_id, 160)?;
                write_atomic(
                    &self
                        .root
                        .join("workstream-plan-amendment-receipts")
                        .join(format!("{receipt_id}.json")),
                    &receipt,
                )?;
            }
            mark(path, journal, "committed")
        })
    }

    fn recovery_compatible(
        &self,
        journal: &Value,
        current: Option<&Value>,
        before: &Value,
        after: &Value,
        kind: RecoveryKind,
    ) -> Result<bool, BtccError> {
        let Some(current) = current else {
            return Ok(false);
        };
        if current != before && current != after {
            return Ok(false);
        }
        if terminal(current) && current != after {
            return Ok(false);
        }
        let before_todo = journal.get("before_todo").cloned().unwrap_or(Value::Null);
        let after_todo = journal.get("after_todo").cloned().unwrap_or(Value::Null);
        if kind == RecoveryKind::Plan && (before_todo.is_null() || after_todo.is_null()) {
            return Err(error("work_stream_recovery_invalid"));
        }
        let todo_id = [after_todo.as_object(), before_todo.as_object()]
            .into_iter()
            .flatten()
            .find_map(|todo| todo.get("list_id").and_then(Value::as_str));
        let actual = match todo_id {
            Some(id) => {
                safe_id(id, 80)?;
                read_object(&self.root.join("todos").join(format!("{id}.json")))?
                    .unwrap_or(Value::Null)
            }
            None => Value::Null,
        };
        Ok(actual == before_todo || actual == after_todo)
    }

    fn write_recovered_todo(&self, journal: &Value, kind: RecoveryKind) -> Result<(), BtccError> {
        let Some(todo) = journal.get("after_todo").filter(|value| !value.is_null()) else {
            return if kind == RecoveryKind::Plan {
                Err(error("work_stream_recovery_invalid"))
            } else {
                Ok(())
            };
        };
        let id = string(todo, "list_id").ok_or_else(|| error("work_stream_recovery_invalid"))?;
        safe_id(&id, 80)?;
        write_atomic(&self.root.join("todos").join(format!("{id}.json")), todo)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RecoveryKind {
    Plan,
    Reporting,
}

impl RecoveryKind {
    fn operation(self) -> &'static str {
        match self {
            Self::Plan => "plan_recovery",
            Self::Reporting => "reporting_recovery",
        }
    }
}

fn object(value: &Value, key: &str) -> Result<Value, BtccError> {
    value
        .get(key)
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(|| error("work_stream_recovery_invalid"))
}

fn mark(path: &Path, mut journal: Value, state: &str) -> Result<(), BtccError> {
    let map = journal
        .as_object_mut()
        .ok_or_else(|| error("work_stream_recovery_invalid"))?;
    map.insert("state".into(), json!(state));
    map.insert("updated_at".into(), json!(now_iso()));
    write_atomic(path, &journal)
}
