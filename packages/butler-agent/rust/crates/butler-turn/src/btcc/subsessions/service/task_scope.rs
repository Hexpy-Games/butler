//! Structural Task checks run under the delegation lock, before dispatch.
use super::*;
mod validation;
use crate::btcc::{TaskContract, TaskInputUse, WorkTask, task_path};
use validation::check_inputs;
pub(super) use validation::validate;

pub(super) fn refusal(code: &str, detail: Value) -> Value {
    let mut error = serde_json::Map::from_iter([
        ("code".into(), Value::String(code.into())),
        ("detail".into(), detail),
    ]);
    let next_action = match code {
        "task_fields_required" => Some(
            "Give task.scope (owns: subjects with aspects, or paths) and task.output (format plus fields or files), then delegate again.",
        ),
        "task_subject_unknown" => Some(
            "Use a subject key listed in registered, or add the subject to the Plan's subjects with replace_work_plan, then delegate again.",
        ),
        _ => None,
    };
    if let Some(next_action) = next_action {
        error.insert("next_action".into(), Value::String(next_action.into()));
    }
    Value::Object(serde_json::Map::from_iter([
        ("ok".into(), Value::Bool(false)),
        ("error".into(), Value::Object(error)),
    ]))
}

impl SubsessionService {
    pub(super) async fn prepare_task(
        &self,
        request: &mut WorkerDelegationRequest,
        work: &WorkView,
        packet: &mut crate::btcc::SubsessionPacket,
    ) -> Result<Option<Value>, BtccError> {
        let tasks = self.repository.work_tasks(work.work_id.clone()).await?;
        let task = request.task.as_mut().ok_or_else(|| {
            BtccError::relayed(
                "task_fields_required",
                "task.scope and task.output are required",
            )
        })?;
        if let Some(error) = validation::replacement(
            task,
            &tasks,
            request.replaces_relation_id.as_deref(),
            &request.action_key,
        ) {
            return Ok(Some(error));
        }
        if let Some(error) =
            replacement_cycle(task, &tasks, request.replaces_relation_id.as_deref())
        {
            return Ok(Some(error));
        }
        if let Some(error) = check_inputs(task, &tasks) {
            return Ok(Some(error));
        }
        packet.task = Some(task.clone());
        packet.task_context = TaskContract::render_packet(packet, &tasks);
        Ok(None)
    }
}

fn waits_on(task: &WorkTask, target: &str, tasks: &[WorkTask]) -> bool {
    let mut pending: Vec<_> = task
        .merge_after
        .iter()
        .chain(task.inputs.iter().map(|i| &i.task))
        .map(String::as_str)
        .collect();
    let mut seen = std::collections::HashSet::new();
    while let Some(id) = pending.pop() {
        if id == target {
            return true;
        }
        if seen.insert(id)
            && let Some(prior) = tasks.iter().find(|t| t.task_id == id)
        {
            pending.extend(
                prior
                    .merge_after
                    .iter()
                    .chain(prior.inputs.iter().map(|i| &i.task))
                    .map(String::as_str),
            );
        }
    }
    false
}

fn replacement_cycle(
    task: &TaskContract,
    tasks: &[WorkTask],
    relation: Option<&str>,
) -> Option<Value> {
    let old = tasks
        .iter()
        .find(|t| Some(t.relation_id.as_str()) == relation)?;
    let cycles = task.inputs.iter().any(|i| i.task == old.task_id)
        || task
            .merge_after
            .iter()
            .chain(task.inputs.iter().map(|i| &i.task))
            .any(|id| {
                tasks.iter().any(|t| {
                    &t.task_id == id && t.status == "pending" && waits_on(t, &old.task_id, tasks)
                })
            });
    cycles.then(|| {
        refusal(
            "task_replacement_dependency_cycle",
            json!({"task":old.task_id}),
        )
    })
}
