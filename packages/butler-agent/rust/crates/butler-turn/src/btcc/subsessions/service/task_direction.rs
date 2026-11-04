//! A retained Worker continuation reserves its same Task before admission.
use super::*;
use crate::btcc::StoredSubsessionDelegation;

impl SubsessionService {
    pub(super) async fn task_direction_error(
        &self,
        relation: &StoredSubsessionDelegation,
    ) -> Result<Option<Value>, BtccError> {
        if relation.packet.task.is_none() {
            return Ok(None);
        }
        let Some(parent) = &relation.packet.parent_work_ref else {
            return Ok(None);
        };
        if !self
            .repository
            .task_owner_open(parent.work_id.clone())
            .await?
        {
            return Ok(Some(task_scope::refusal(
                "task_owner_terminal",
                json!({"task":relation.task_id,"message":"Assign a Task in the current Work instead."}),
            )));
        }
        let tasks = self.repository.work_tasks(parent.work_id.clone()).await?;
        let Some(own) = tasks.iter().find(|t| t.task_id == relation.task_id) else {
            return Ok(None);
        };
        if own.status == "superseded" {
            return Ok(Some(task_scope::refusal(
                "task_superseded",
                json!({"task":own.task_id}),
            )));
        }
        Ok(None)
    }
    pub(super) async fn task_inputs_ready(
        &self,
        stored: &StoredSubsessionDelegation,
    ) -> Result<(), BtccError> {
        let Some(task) = &stored.packet.task else {
            return Ok(());
        };
        if task.inputs.is_empty() {
            return Ok(());
        }
        let Some(parent) = &stored.packet.parent_work_ref else {
            return Ok(());
        };
        let tasks = self.repository.work_tasks(parent.work_id.clone()).await?;
        if task.inputs.iter().any(|i| {
            !tasks
                .iter()
                .any(|t| t.task_id == i.task && t.status == "done" && t.result_ref.is_some())
        }) {
            return Err(BtccError::relayed(
                "task_input_not_done",
                "A declared Task input did not finish with a confirmed result.",
            ));
        }
        Ok(())
    }
    pub(super) async fn stop_replaced_worker(
        &self,
        input: &crate::btcc::SubsessionCreate,
        old: &str,
    ) -> Result<(), BtccError> {
        let ended = || async {
            Ok::<_, BtccError>(
                self.repository
                    .result_for_relation(old.into())
                    .await?
                    .is_some()
                    && !self.repository.worker_cancellable(old.into()).await?,
            )
        };
        if ended().await? {
            return Ok(());
        }
        let result = self
            .cancel(SubsessionCancelRequest {
                parent_session_id: input.parent_session_id.clone(),
                parent_turn_id: input.parent_turn_id.clone(),
                source_message_id: input.anchor_message_id.clone(),
                relation_id: Some(old.into()),
                safe_title: None,
                child_role: SessionRole::Worker,
            })
            .await;
        match result {
            Ok(_) => Ok(()),
            Err(error)
                if error.code() == "active_steward_relation_not_found" && ended().await? =>
            {
                Ok(())
            }
            Err(error) => Err(error),
        }
    }
}
