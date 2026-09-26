use std::{collections::HashSet, fs, path::PathBuf};

use rusqlite::params;
use serde_json::{Value, json};

use super::WorkStreamScope;
use crate::{btcc::BtccError, gateway::AppWorkStreamQuery};

use super::support::*;

pub(super) struct Store {
    pub(super) root: PathBuf,
}

impl Store {
    pub(super) fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub(super) fn update_todo(
        &mut self,
        scope: WorkStreamScope,
        input: Value,
    ) -> Result<Value, BtccError> {
        self.recover_pending()?;
        let object = input
            .as_object()
            .ok_or_else(|| error("work_stream_input_invalid"))?;
        let list_id = list_id(object.get("list_id"), &scope.turn_id)?;
        let now = now_iso();
        let prior_todo = read_object(&self.root.join("todos").join(format!("{list_id}.json")))?;
        let items = todo_items(object.get("todos"), prior_todo.as_ref(), &now)?;
        let title = text(object.get("title"), 120)
            .or_else(|| prior_todo.as_ref().and_then(|value| string(value, "title")));
        let todo = json!({
            "version":1,"list_id":list_id,"title":title,
            "created_at":prior_todo.as_ref().and_then(|value|string(value,"created_at")).unwrap_or_else(||now.clone()),
            "updated_at":now,"items":items
        });
        let base_id = stable_stream_id(&scope, &list_id);
        let base = self.read_stream(&base_id)?;
        let id = if base.as_ref().is_some_and(terminal) {
            revision_stream_id(&base_id, &now)
        } else {
            base_id
        };
        let prior = self.read_stream(&id)?;
        let target = target(&items, prior.as_ref());
        let record = self.mutate(&id, "legacy_todo_update", |current| {
            if current
                .as_ref()
                .and_then(|record| record.get("active_contract_id"))
                .is_some_and(|value| !value.is_null())
            {
                return Err(error("work_stream_contract_authorization_required"));
            }
            if current.as_ref().is_some_and(terminal) && !TERMINAL.contains(&target.0.as_str()) {
                return Err(failure(
                    "work_stream_terminal_immutable",
                    "Terminal WorkStream cannot be reopened",
                ));
            }
            let source = current.as_ref().or(base.as_ref());
            let generation = current
                .as_ref()
                .map(|value| integer(value, "record_generation").unwrap_or(1))
                .unwrap_or(0)
                + 1;
            let mut record = current.clone().unwrap_or_else(|| {
                json!({
                    "version":1,"id":id,"intent_summary":source.and_then(|v|v.get("intent_summary")).cloned().unwrap_or(Value::Null),
                    "role_hint":source.and_then(|v|v.get("role_hint")).cloned().unwrap_or(Value::Null),
                    "expected_deliverable":source.and_then(|v|v.get("expected_deliverable")).cloned().unwrap_or(Value::Null),
                    "linked_planned_task_ids":array(source,"linked_planned_task_ids"),
                    "linked_orchestration_ids":array(source,"linked_orchestration_ids"),
                    "linked_worker_task_ids":array(source,"linked_worker_task_ids"),
                    "created_at":now,"active_contract_id":null,"claim_generation":null,
                    "claim_lease_expires_at":null,"active_claim_receipt_id":null,
                    "original_claim_receipt_id":null,"active_blocker_id":null,
                    "active_blocker_evidence_id":null,"plan_revision":1,
                    "plan_revision_receipt_id":null,"superseded_todo_ids":[]
                })
            });
            let map = record.as_object_mut().ok_or_else(|| error("work_stream_record_invalid"))?;
            for (key, default) in [
                ("intent_summary", Value::Null),
                ("role_hint", Value::Null),
                ("expected_deliverable", Value::Null),
                ("linked_planned_task_ids", json!([])),
                ("linked_orchestration_ids", json!([])),
                ("linked_worker_task_ids", json!([])),
                ("created_at", json!(now.clone())),
            ] {
                map.entry(key).or_insert(default);
            }
            for (key, default) in contract_field_defaults() {
                map.entry(key).or_insert(default);
            }
            map.insert("version".into(), json!(1));
            map.insert("id".into(), json!(id));
            map.insert("title".into(), json!(title.clone().or_else(||source.and_then(|v|string(v,"title"))).unwrap_or_else(||"Butler work stream".into())));
            map.insert("owner_session_id".into(), json!(scope.session_id));
            map.insert("origin_chat_id".into(), scope.origin_chat_id.clone().map(Value::String).or_else(||source.and_then(|v|v.get("origin_chat_id")).cloned()).unwrap_or(Value::Null));
            map.insert("project_id".into(), scope.project_id.clone().map(Value::String).or_else(||source.and_then(|v|v.get("project_id")).cloned()).unwrap_or(Value::Null));
            map.insert("state".into(), json!(target.0));
            map.insert("current_phase".into(), target.1.clone());
            map.insert("active_step_id".into(), target.2.clone());
            map.insert("todo_list_id".into(), json!(list_id));
            map.insert("updated_at".into(), json!(now));
            map.insert("last_user_turn_id".into(), json!(scope.turn_id));
            map.insert("status_note".into(), if target.0 == "complete" { Value::Null } else { source.and_then(|v|v.get("status_note")).cloned().unwrap_or(Value::Null) });
            map.insert("record_generation".into(), json!(generation));
            write_atomic(&self.root.join("todos").join(format!("{list_id}.json")), &todo)?;
            Ok(record)
        })?;
        Ok(
            json!({"ok":true,"list_id":list_id,"title":title,"items":items,
            "progress":progress(&items),"work_stream":record}),
        )
    }

    pub(super) fn list(
        &mut self,
        scope: WorkStreamScope,
        input: Value,
    ) -> Result<Value, BtccError> {
        self.recover_pending()?;
        let session = input
            .get("session_id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&scope.session_id);
        let project = input.get("project_id").and_then(Value::as_str);
        let include_terminal = input
            .get("include_terminal")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let streams = self
            .records()?
            .into_iter()
            .filter(|record| string(record, "owner_session_id").as_deref() == Some(session))
            .filter(|record| {
                project.is_none_or(|id| string(record, "project_id").as_deref() == Some(id))
            })
            .filter(|record| include_terminal || !terminal(record))
            .map(|record| summary(&record))
            .collect::<Vec<_>>();
        Ok(json!({"ok":true,"work_streams":streams}))
    }

    pub(super) fn transition(
        &mut self,
        scope: WorkStreamScope,
        input: Value,
    ) -> Result<Value, BtccError> {
        self.recover_pending()?;
        let id = input
            .get("work_stream_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                self.active_for_session(&scope.session_id, &scope.turn_id)
                    .ok()
                    .flatten()
            })
            .ok_or_else(|| failure("work_stream_not_found", "No active WorkStream"))?;
        safe_id(&id, 120)?;
        let state = input
            .get("state")
            .and_then(Value::as_str)
            .ok_or_else(|| error("work_stream_state_invalid"))?;
        validate_state(state)?;
        let now = now_iso();
        let record = self.mutate(&id, "legacy_transition", |current| {
            let mut record = current.ok_or_else(|| failure("work_stream_not_found", &id))?;
            let from =
                string(&record, "state").ok_or_else(|| error("work_stream_record_invalid"))?;
            validate_transition(&from, state)?;
            let map = record
                .as_object_mut()
                .ok_or_else(|| error("work_stream_record_invalid"))?;
            map.insert("state".into(), json!(state));
            map.insert(
                "current_phase".into(),
                phase(state, map.get("current_phase")),
            );
            if let Some(value) = input.get("active_step_id") {
                map.insert("active_step_id".into(), value.clone());
            }
            if let Some(value) = text(input.get("status_note"), 600) {
                map.insert("status_note".into(), json!(value));
            }
            map.insert("updated_at".into(), json!(now));
            map.insert(
                "record_generation".into(),
                json!(integer(&Value::Object(map.clone()), "record_generation").unwrap_or(1) + 1),
            );
            Ok(record)
        })?;
        Ok(json!({"ok":true,"work_stream":record}))
    }

    pub(super) fn active(&mut self, query: AppWorkStreamQuery) -> Result<Value, BtccError> {
        self.recover_pending()?;
        let scopes = [
            query.app_session_id.as_str(),
            query.runtime_session_id.as_str(),
        ];
        let mut seen = HashSet::new();
        let mut result = Vec::new();
        let records = self.records()?;
        for scope in scopes {
            for record in &records {
                if result.len() == 10 {
                    break;
                }
                if string(record, "owner_session_id").as_deref() != Some(scope) {
                    continue;
                }
                if !active(record, query.current_turn_id.as_deref())
                    || !visible(record, query.current_turn_id.as_deref())
                {
                    continue;
                }
                let Some(id) = string(record, "id") else {
                    continue;
                };
                if seen.insert(id) {
                    result.push(summary(record));
                }
            }
        }
        Ok(Value::Array(result))
    }

    pub(super) fn link(
        &mut self,
        scope: WorkStreamScope,
        target_id: String,
        field: &'static str,
    ) -> Result<Value, BtccError> {
        self.recover_pending()?;
        if !matches!(field, "linked_orchestration_ids" | "linked_worker_task_ids") {
            return Err(error("work_stream_link_invalid"));
        }
        safe_id(&target_id, 120)?;
        let Some(id) = self.active_for_session(&scope.session_id, &scope.turn_id)? else {
            return Ok(json!({"linked":false}));
        };
        let record = self.mutate(&id, "legacy_link", |current| {
            let mut record = current.ok_or_else(|| failure("work_stream_not_found", &id))?;
            let map = record
                .as_object_mut()
                .ok_or_else(|| error("work_stream_record_invalid"))?;
            let mut linked = map
                .get(field)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if !linked
                .iter()
                .any(|value| value.as_str() == Some(&target_id))
            {
                linked.push(json!(target_id));
                linked.sort_by_key(|value| value.as_str().unwrap_or_default().to_owned());
            }
            let generation = map
                .get("record_generation")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                + 1;
            map.insert(field.into(), Value::Array(linked));
            map.insert("updated_at".into(), json!(now_iso()));
            map.insert("record_generation".into(), json!(generation));
            Ok(record)
        })?;
        Ok(json!({"linked":true,"work_stream":record}))
    }

    pub(super) fn records(&self) -> Result<Vec<Value>, BtccError> {
        let directory = self.root.join("work-streams");
        let mut records = Vec::new();
        let Ok(entries) = fs::read_dir(directory) else {
            return Ok(records);
        };
        for entry in entries {
            let entry = entry.map_err(io_error)?;
            if entry.path().extension().and_then(|v| v.to_str()) != Some("json") {
                continue;
            }
            if let Some(record) = read_object(&entry.path())?
                && integer(&record, "version") == Some(1)
                && string(&record, "id").is_some()
            {
                records.push(record);
            }
        }
        records.sort_by_key(|record| std::cmp::Reverse(string(record, "updated_at")));
        Ok(records)
    }

    fn active_for_session(&self, session: &str, turn: &str) -> Result<Option<String>, BtccError> {
        Ok(self.records()?.into_iter().find_map(|record| {
            (string(&record, "owner_session_id").as_deref() == Some(session)
                && active(&record, Some(turn)))
            .then(|| string(&record, "id"))
            .flatten()
        }))
    }

    fn read_stream(&self, id: &str) -> Result<Option<Value>, BtccError> {
        read_object(&self.root.join("work-streams").join(format!("{id}.json")))
    }

    pub(super) fn mutate(
        &self,
        id: &str,
        operation: &str,
        change: impl FnOnce(Option<Value>) -> Result<Value, BtccError>,
    ) -> Result<Value, BtccError> {
        self.with_lock(id, operation, |current| {
            let expected = current
                .as_ref()
                .map(|value| integer(value, "record_generation").unwrap_or(1));
            let next = change(current)?;
            let next_generation = integer(&next, "record_generation").unwrap_or(1);
            if next_generation != expected.unwrap_or(0) + 1 {
                return Err(error("work_stream_generation_conflict"));
            }
            write_atomic(
                &self.root.join("work-streams").join(format!("{id}.json")),
                &next,
            )?;
            Ok(next)
        })
    }

    pub(super) fn with_lock<T>(
        &self,
        id: &str,
        operation: &str,
        action: impl FnOnce(Option<Value>) -> Result<T, BtccError>,
    ) -> Result<T, BtccError> {
        let lock_key = self
            .root
            .join("work-streams")
            .join(format!("{id}.mutation.lock"));
        let mut connection = open_lock(&self.root, &lock_key)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        let token = uuid::Uuid::new_v4().to_string();
        transaction
            .execute(
                "UPDATE shard_fence SET generation=generation+1 WHERE singleton=1",
                [],
            )
            .map_err(sql_error)?;
        transaction
            .execute(
                "INSERT INTO active_lock(lock_key,ownership_token,owner_id,acquired_at,renewed_at)
             VALUES(?1,?2,?3,?4,?4) ON CONFLICT(lock_key) DO UPDATE SET
             ownership_token=excluded.ownership_token,owner_id=excluded.owner_id,
             acquired_at=excluded.acquired_at,renewed_at=excluded.renewed_at",
                params![
                    lock_key.to_string_lossy(),
                    token,
                    format!("{operation}:{id}"),
                    now_iso()
                ],
            )
            .map_err(sql_error)?;
        let current = read_object(&self.root.join("work-streams").join(format!("{id}.json")))?;
        let result = action(current)?;
        transaction
            .execute(
                "DELETE FROM active_lock WHERE lock_key=?1 AND ownership_token=?2",
                params![lock_key.to_string_lossy(), token],
            )
            .map_err(sql_error)?;
        transaction.commit().map_err(sql_error)?;
        Ok(result)
    }
}
