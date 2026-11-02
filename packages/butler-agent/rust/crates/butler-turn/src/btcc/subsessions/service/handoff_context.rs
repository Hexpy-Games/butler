//! Runtime-owned context of a Plan action, and publication target enforcement.
use super::*;
use crate::btcc::SubsessionPacket;

impl SubsessionService {
    pub(super) async fn worker_handoff_context(
        &self,
        packet: &mut SubsessionPacket,
        reviewed: &WorkView,
    ) -> Result<(), BtccError> {
        if let Some(parent) = self
            .repository
            .by_child(packet.parent_session_id.clone())
            .await?
        {
            packet.user_request = parent.packet.user_request;
        }
        let workers = self
            .repository
            .workers_for_work(packet.parent_session_id.clone(), reviewed.work_id.clone())
            .await?;
        let Some(action) = &packet.plan_action else {
            return Ok(());
        };
        for key in &action.dependency_keys {
            for worker in workers.iter().filter(|worker| {
                worker.packet.superseded_by.is_none()
                    && worker
                        .packet
                        .plan_action
                        .as_ref()
                        .is_some_and(|action| &action.action_key == key)
            }) {
                if packet
                    .task
                    .as_ref()
                    .is_some_and(|t| t.inputs.iter().any(|i| i.task == worker.task_id))
                {
                    continue;
                }
                let Some(result) = self
                    .repository
                    .result_for_relation(worker.relation_id.clone())
                    .await?
                else {
                    continue;
                };
                if result.get("status").and_then(Value::as_str) != Some("success") {
                    continue;
                }
                let summary = result.get("summary").and_then(Value::as_str).unwrap_or("");
                let mut excerpt: String = summary.chars().take(4000).collect();
                if summary.chars().count() > 4000 {
                    excerpt.push('…');
                }
                packet.earlier_steps.push(format!(
                    "{key} (session {}): {excerpt}",
                    crate::conversation::conversation_session_id_for_durable_session(
                        &worker.child_session_id
                    )
                ));
            }
        }
        Ok(())
    }

    pub(super) async fn replace_action_worker(
        &self,
        request: &WorkerDelegationRequest,
        work: &WorkView,
    ) -> Result<Option<Value>, BtccError> {
        let workers = self
            .repository
            .workers_for_work(request.parent_session_id.clone(), work.work_id.clone())
            .await?;
        for worker in workers {
            if request
                .replaces_relation_id
                .as_deref()
                .is_some_and(|id| id != worker.relation_id)
                || (request.replaces_relation_id.is_none() && worker.packet.task.is_some())
                || worker.packet.superseded_by.is_some()
                || worker
                    .packet
                    .plan_action
                    .as_ref()
                    .is_none_or(|action| action.action_key != request.action_key)
            {
                continue;
            }
            if self
                .repository
                .result_for_relation(worker.relation_id.clone())
                .await?
                .is_some()
                && !self
                    .repository
                    .worker_cancellable(worker.relation_id.clone())
                    .await?
            {
                continue;
            }
            let id = &worker.relation_id;
            if request.replaces_relation_id.as_deref() != Some(id) {
                return Ok(Some(json!({"ok":false,"running_relation_id":id,"error":{
                    "code":"action_worker_running", "message": format!("Worker {id} is still running action {}. Wait for it with wait_for_worker, correct it with steer_worker, or pass replaces_relation_id {id} to stop it and assign this instead.", request.action_key)
                }})));
            }
        }
        Ok(None)
    }

    pub(super) async fn recover_superseded_workers(&self) -> Result<(), BtccError> {
        for worker in self.repository.superseded_workers().await? {
            if self
                .repository
                .result_for_relation(worker.relation_id.clone())
                .await?
                .is_some()
                && !self
                    .repository
                    .worker_cancellable(worker.relation_id.clone())
                    .await?
            {
                continue;
            }
            self.cancel_by_relation(worker.parent_session_id, worker.relation_id, "superseded")
                .await?;
        }
        Ok(())
    }

    /// A role-specific, model-visible refusal; lookups are scoped to the caller.
    pub async fn publish_target_error(
        &self,
        session: &str,
        work: Option<&str>,
        workspace: &std::path::Path,
        path: &str,
    ) -> Result<Option<Value>, BtccError> {
        let Some(own) = self.repository.by_child(session.into()).await? else {
            return Ok(None);
        };
        let target = if own.packet.child_role == ChildRole::Worker {
            own.packet.target_path.clone()
        } else if let Some(work) = work {
            self.latest_publish_target(session, work).await?
        } else {
            None
        };
        let Some(target) = target else {
            return Ok(None);
        };
        let matches = normalized_path(workspace, path)
            .zip(normalized_path(workspace, &target))
            .is_some_and(|(path, target)| target.starts_with(&path));
        if matches {
            return Ok(None);
        }
        let message = if own.packet.child_role == ChildRole::Worker {
            format!("Your assignment revises and checks {target}, not {path}. Publish {target}.")
        } else {
            format!(
                "The latest revision and check in this Work were on {target}, not {path}. Publish {target}, or assign the revision of {path} with target_path before publishing it."
            )
        };
        Ok(Some(
            json!({"ok":false,"error":{"code":"publish_target_mismatch","message":message}}),
        ))
    }

    async fn latest_publish_target(
        &self,
        session: &str,
        work: &str,
    ) -> Result<Option<String>, BtccError> {
        for worker in self
            .repository
            .workers_for_work(session.into(), work.into())
            .await?
        {
            if worker.packet.superseded_by.is_some() || worker.packet.target_path.is_none() {
                continue;
            }
            let result = self
                .repository
                .result_for_relation(worker.relation_id.clone())
                .await?;
            if result.as_ref().is_some_and(|result| {
                result.get("status").and_then(Value::as_str) == Some("cancelled")
            }) {
                continue;
            }
            return Ok(worker.packet.target_path);
        }
        Ok(None)
    }
}

fn normalized_path(workspace: &std::path::Path, path: &str) -> Option<std::path::PathBuf> {
    use std::path::Component;
    let mut normalized = std::path::PathBuf::new();
    let path = std::path::Path::new(path);
    let relative = if path.is_absolute() {
        path.strip_prefix(workspace).ok()?
    } else {
        path
    };
    for part in relative.components() {
        match part {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir if normalized.pop() => {}
            _ => return None,
        }
    }
    Some(normalized)
}
