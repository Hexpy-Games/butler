//! Read-only App projection from the BTCC subsession authority.

use serde_json::{Value, json};

use super::NativeSubsessionService;
use crate::btcc::BtccCode;
use crate::btcc::{BtccError, StoredSubsessionDelegation};

impl NativeSubsessionService {
    pub(crate) async fn worker_prompt_lines(
        &self,
        parent_session_id: String,
        task_ids: Vec<String>,
    ) -> Result<Vec<String>, BtccError> {
        if task_ids.is_empty() {
            return Ok(Vec::new());
        }
        let wanted = task_ids
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        let relations = self
            .repository
            .relations_for_parent(parent_session_id)
            .await
            .map_err(BtccError::from)?;
        let mut lines = Vec::new();
        for relation in relations
            .into_iter()
            .filter(|relation| wanted.contains(&relation.task_id))
            .take(8)
        {
            if relation.packet.get("child_role").and_then(Value::as_str) != Some("worker") {
                continue;
            }
            let projected = self.project_child(&relation).await?;
            let status = projected
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("waiting");
            let phase = relation
                .packet
                .get("execution_mode")
                .and_then(Value::as_str)
                .unwrap_or("worker");
            let summary = projected
                .pointer("/result/summary")
                .and_then(Value::as_str)
                .or_else(|| relation.packet.get("objective").and_then(Value::as_str))
                .unwrap_or(&relation.safe_title);
            lines.push(format!(
                "- {}: {status}; {phase}; {summary}",
                relation.task_id
            ));
        }
        Ok(lines)
    }

    pub(crate) async fn app_projection(&self, session_id: &str) -> Result<Value, BtccError> {
        let children = self
            .repository
            .relations_for_parent(session_id.into())
            .await
            .map_err(BtccError::from)?;
        let relation = self
            .repository
            .by_child(session_id.into())
            .await
            .map_err(BtccError::from)?;
        let mut summaries = Vec::new();
        for child in children {
            summaries.push(self.project_child(&child).await?);
        }
        let (stewards, workers): (Vec<_>, Vec<_>) = summaries
            .into_iter()
            .partition(|value| value.get("role").and_then(Value::as_str) == Some("steward"));
        let own = if let Some(relation) = relation {
            Some(self.project_child(&relation).await?)
        } else {
            None
        };
        let mut projection =
            own.unwrap_or_else(|| json!({"session_id":session_id,"relation":null,"status":"idle"}));
        let object = projection.as_object_mut().ok_or_else(|| {
            BtccError::detected(BtccCode::SubsessionProjectionInvalid, "projection invalid")
        })?;
        object.insert("steward_children".into(), json!(stewards));
        object.insert("workers".into(), json!(workers));
        Ok(projection)
    }

    async fn project_child(
        &self,
        relation: &StoredSubsessionDelegation,
    ) -> Result<Value, BtccError> {
        let latest = self
            .repository
            .latest_turn(relation.child_session_id.clone())
            .await
            .map_err(BtccError::from)?;
        let result = self
            .repository
            .result_for_relation(relation.relation_id.clone())
            .await
            .map_err(BtccError::from)?;
        let role = relation
            .packet
            .get("child_role")
            .and_then(Value::as_str)
            .unwrap_or("worker");
        let status = match result
            .as_ref()
            .and_then(|value| value.get("status"))
            .and_then(Value::as_str)
        {
            Some("success") => "completed",
            Some("cancelled") => "cancelled",
            Some("blocked") => "blocked",
            Some("failed") => "failed",
            _ if latest
                .as_ref()
                .is_some_and(|(_, state)| state == "admitted") =>
            {
                "active"
            }
            _ => "waiting",
        };
        let turn=latest.as_ref().map(|(id,state)|json!({"id":id,"state":state,"created_at":relation.created_at,"updated_at":relation.created_at}));
        let relation_view = json!({"relation_id":relation.relation_id,"parent_session_id":relation.parent_session_id,"parent_turn_id":relation.parent_turn_id,"child_session_id":relation.child_session_id,"anchor_message_id":relation.anchor_message_id,"ordinal":relation.ordinal,"safe_title":relation.safe_title,"created_at":relation.created_at});
        let result_view = result.map(|mut value| {
            if let Some(object) = value.as_object_mut() {
                object.insert("relation_id".into(), json!(relation.relation_id));
                object.insert("task_id".into(), json!(relation.task_id));
                object.insert("child_session_id".into(), json!(relation.child_session_id));
            }
            value
        });
        Ok(
            json!({"role":role,"relation":relation_view,"session_id":relation.child_session_id,"title":relation.safe_title,"status":status,"active_turn":if status=="active"{turn.clone()}else{None},"latest_turn":turn,"waiting_for_children":false,"result":result_view,"updated_at":relation.created_at,"terminal":result_view.is_some()}),
        )
    }
}
