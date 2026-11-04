//! Structural ownership checks run under the delegation lock, before dispatch.
use super::*;
mod validation;
use crate::btcc::{TaskContract, TaskInputUse, TaskOverlap, WorkTask, task_overlap, task_path};
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
        "task_scope_overlap" => Some(
            "Another Task owns these cells. If it is done, build on its result: list it in task.inputs (use facts, artifact to revise it, or verify with a reason). If it is still running, set task.overlap to wait or merge with a reason, or narrow this Task's scope.",
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
        let overlaps = overlaps(task, &tasks, request.replaces_relation_id.as_deref());
        if let Some(error) = blocked_overlap(task, &overlaps) {
            self.record_narrow(&packet.task_id, task, &overlaps).await?;
            return Ok(Some(error));
        }
        packet.task_overlaps = overlap_records(task, &overlaps);
        let running: Vec<_> = overlaps
            .iter()
            .filter(|(t, _)| t.status != "done")
            .collect();
        if task
            .overlap
            .as_ref()
            .is_some_and(|r| r.resolution == "merge")
            && !running.is_empty()
        {
            let [target] = running.as_slice() else {
                return Ok(Some(refusal(
                    "task_merge_multiple",
                    json!("Narrow to one running Task before merging"),
                )));
            };
            let target = target.0;
            let result = self
                .merge_task(request, target, packet.task_overlaps.clone())
                .await?;
            return Ok(Some(result));
        }
        for (prior, _) in running {
            if !task.merge_after.contains(&prior.task_id) {
                task.merge_after.push(prior.task_id.clone());
            }
        }
        packet.task = Some(task.clone());
        packet.task_context = TaskContract::render_packet(packet, &tasks);
        Ok(None)
    }

    async fn record_narrow(
        &self,
        proposed: &str,
        task: &TaskContract,
        overlaps: &[(&WorkTask, Vec<String>)],
    ) -> Result<(), BtccError> {
        let Some(resolution) = task.overlap.as_ref().filter(|r| r.resolution == "narrow") else {
            return Ok(());
        };
        for (prior, cells) in overlaps {
            self.repository
                .record_task_overlaps(
                    prior.task_id.clone(),
                    vec![TaskOverlap {
                        task: proposed.into(),
                        cells: cells.clone(),
                        resolution: "narrow".into(),
                        reason: resolution.reason.clone(),
                    }],
                )
                .await?;
        }
        Ok(())
    }

    async fn merge_task(
        &self,
        request: &WorkerDelegationRequest,
        target: &WorkTask,
        records: Vec<TaskOverlap>,
    ) -> Result<Value, BtccError> {
        let result = self
            .steer_locked(SubsessionDirectionRequest {
                parent_session_id: request.parent_session_id.clone(),
                parent_turn_id: request.parent_turn_id.clone(),
                source_message_id: request.anchor_message_id.clone(),
                relation_id: Some(target.relation_id.clone()),
                work_id: None,
                safe_title: None,
                instruction: format!("{}\n{}", request.objective, request.implementation_brief),
                child_role: SessionRole::Worker,
                access_mode: request.access_mode.as_str().into(),
                schedule_run: request.schedule_run.clone(),
                immediate: false,
            })
            .await?;
        if result.get("ok").and_then(Value::as_bool) == Some(true) {
            self.repository
                .record_task_overlaps(target.task_id.clone(), records)
                .await?;
        }
        Ok(result)
    }
}

fn overlaps<'a>(
    task: &TaskContract,
    tasks: &'a [WorkTask],
    replacement: Option<&str>,
) -> Vec<(&'a WorkTask, Vec<String>)> {
    let Some(scope) = &task.scope else {
        return Vec::new();
    };
    let replaced = tasks
        .iter()
        .find(|t| Some(t.relation_id.as_str()) == replacement)
        .map(|t| t.task_id.as_str());
    tasks
        .iter()
        .filter(|t| {
            matches!(t.status.as_str(), "pending" | "active" | "done")
                && Some(t.relation_id.as_str()) != replacement
                && !(t.status == "pending" && replaced.is_some_and(|id| waits_on(t, id, tasks)))
        })
        .filter_map(|t| {
            let cells = task_overlap(scope, &t.scope);
            (!cells.is_empty()).then_some((t, cells))
        })
        .collect()
}

fn overlap_records(task: &TaskContract, overlaps: &[(&WorkTask, Vec<String>)]) -> Vec<TaskOverlap> {
    overlaps
        .iter()
        .map(|(t, cells)| {
            let input = task.inputs.iter().find(|i| i.task == t.task_id);
            let (resolution, reason) = if t.status == "done" {
                (
                    input
                        .map(|i| match i.usage {
                            TaskInputUse::Verify => "verify",
                            TaskInputUse::Facts => "facts",
                            TaskInputUse::Artifact => "artifact",
                        })
                        .unwrap_or(""),
                    input.and_then(|i| i.reason.as_deref()).unwrap_or(""),
                )
            } else {
                task.overlap
                    .as_ref()
                    .map(|r| (r.resolution.as_str(), r.reason.as_str()))
                    .unwrap_or(("", ""))
            };
            TaskOverlap {
                task: t.task_id.clone(),
                cells: cells.clone(),
                resolution: resolution.into(),
                reason: reason.into(),
            }
        })
        .collect()
}

fn blocked_overlap(task: &TaskContract, overlaps: &[(&WorkTask, Vec<String>)]) -> Option<Value> {
    let blocked: Vec<_> = overlaps
        .iter()
        .filter(|(t, _)| {
            if t.status == "done" {
                !task.inputs.iter().any(|i| i.task == t.task_id)
            } else {
                task.overlap
                    .as_ref()
                    .is_none_or(|r| !matches!(r.resolution.as_str(), "wait" | "merge"))
            }
        })
        .map(|(t, cells)| {
            json!({"task":t.task_id,"status":t.status,"cells":cells,
            "result_ref":t.result_ref.as_ref().map(|r| format!("evidence:{r}"))})
        })
        .collect();

    (!blocked.is_empty()).then(|| refusal("task_scope_overlap", json!({"overlaps":blocked})))
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
