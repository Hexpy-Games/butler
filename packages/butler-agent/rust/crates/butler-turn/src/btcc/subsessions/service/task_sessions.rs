//! Ready Tasks enter the existing steward admission path, without a worker cap.
use super::*;
use butler_work::{store, store::ReadyStart};

impl SubsessionService {
    pub async fn start_task_session(&self, ready: ReadyStart) -> Result<(), BtccError> {
        let parent = self
            .bindings
            .get_by_session_id(&ready.coordinator_session)
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(BtccCode::SubsessionParentBindingMissing))?;
        let task = ready.task_id.clone();
        let row = self
            .repository
            .storage()
            .work_model_read(move |db| store::read_task(db, &task))
            .await
            .map_err(BtccError::from)?;
        let policy_task = ready.task_id.clone();
        let context = self
            .repository
            .storage()
            .work_model_read(move |db| {
                use rusqlite::OptionalExtension;
                let payload: Option<String> = db
                    .query_row(
                        store::sql::INTENT,
                        [format!("task_execution_context:{policy_task}")],
                        |r| r.get("payload_json"),
                    )
                    .optional()?;
                let p: Value = serde_json::from_str(payload.as_deref().unwrap_or("{}"))?;
                Ok(p)
            })
            .await
            .map_err(BtccError::from)?;
        let text = |key: &str| row[key].as_str().unwrap_or_default().to_owned();
        let input = admission::AssignmentRequest {
            parent_session_id: ready.coordinator_session,
            parent_turn_id: context["turn_id"].as_str().unwrap_or(&ready.task_id).into(),
            anchor_message_id: row["origin_message_id"]
                .as_str()
                .unwrap_or(&ready.task_id)
                .into(),
            request: format!("{}\n{}", text("title"), text("description")),
            task_id: Some(ready.task_id),
            part_id: None,
            role: ChildRole::Steward,
            safe_title: Some(text("title")),
            model_ref: parent.model_ref.clone(),
            reasoning_effort: parent
                .metadata
                .as_ref()
                .and_then(|m| m.get("reasoning_effort"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .into(),
            access_mode: context["access_mode"]
                .as_str()
                .unwrap_or("read_only")
                .into(),
            parent_chat_id: parent
                .transport_bindings
                .iter()
                .find(|b| b.transport == "app")
                .map(|b| b.peer_id.clone()),
            prior_context: None,
            implementation_brief: None,
            worker_prompt: None,
            worker_profile: None,
            schedule_run: None,
        };
        self.admit_assignment(input, parent).await?;
        Ok(())
    }
}
